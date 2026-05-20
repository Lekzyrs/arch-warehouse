import amqp from "amqplib";
import { Counter } from "prom-client";
import { z } from "zod";
import {
  DLQ_QUEUE,
  DLX_EXCHANGE,
  QUEUE_STOCK_LOW,
  ROUTING_KEY_STOCK_LOW,
  WAREHOUSE_EXCHANGE,
} from "../../shared-contracts/src/messaging";
import { RABBIT_CONFIG } from "../../shared-contracts/src/rabbitmq-config";
import { sendLowStockEmail } from "./emailer";
import { registry } from "./metrics/registry";

// EDA-02 + EDA-04 hardened consumer:
//   - DLX exchange + DLQ asserted, main queue имеет x-dead-letter-exchange arg
//   - poison message validated zod'ом, на провал nack(false,false) -> DLQ
//   - sendLowStockEmail в try/catch: email error -> non-fatal, ack всё равно
//   - notifications_consumed_total Counter с labels success/validation_error/email_error
//   - prefetch(1), noAck:false, manual ack/nack
//
// EDA-05 reconnect:
//   - startConsumerWithRetry оборачивает startConsumer в exponential backoff loop
//     (1s, 2s, 4s, 8s, 16s; max 5 attempts). после max - process.exit(1) и
//     restart:unless-stopped поднимет контейнер заново (T-05-15).
//   - connection.on('close') внутри startConsumer триггерит startConsumerWithRetry(1)
//     при unexpected restart брокера.
//
// At-least-once delivery: a consumer restart before ack causes redelivery.
// duplicate emails are possible. idempotent deduplication (processed-events log)
// is out of scope - see REQUIREMENTS.md Out of Scope. msg.fields.redelivered=true
// логируется для defense, чтобы было видно факт повторной доставки.

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const BACKOFF_MULTIPLIER = 2;

// zod-валидация payload - первый и единственный гейт между брокером и
// побочными эффектами (email, metrics, log). T-05-07/T-05-08 mitigation.
const StockLowEventSchema = z.object({
  productId: z.string(),
  warehouseId: z.string(),
  locationId: z.string().optional(),
  available: z.number(),
  threshold: z.number(),
  aggregateId: z.string(),
  occurredAt: z.string(),
});

// module-level Counter, регистрируется в общем registry чтобы попасть в
// /actuator/prometheus. labels: 'success' | 'validation_error' | 'email_error'.
const notifications_consumed_total = new Counter({
  name: "notifications_consumed_total",
  help: "Total notification messages consumed",
  labelNames: ["result"],
  registers: [registry],
});

// safe-parse productId без выкидывания исключений - используется только в
// redelivery-логе чтобы оставить productId если получится, иначе null.
function tryParseProductId(raw: string): string | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.productId === "string") {
      return obj.productId;
    }
    return null;
  } catch {
    return null;
  }
}

async function startConsumer(): Promise<void> {
  const url = process.env.RABBITMQ_URL ?? RABBIT_CONFIG.url;
  if (!url) {
    throw new Error("RABBITMQ_URL env var is required");
  }

  const conn = await amqp.connect(url);
  const ch = await conn.createChannel();

  // DLX-инфраструктура поднимается первой - direct exchange + durable DLQ,
  // DLQ привязан к DLX по routing-key равному имени main queue
  // (x-dead-letter-routing-key ниже зеркалит это).
  await ch.assertExchange(DLX_EXCHANGE, "direct", { durable: true });
  await ch.assertQueue(DLQ_QUEUE, { durable: true });
  await ch.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, QUEUE_STOCK_LOW);

  // RabbitMQ rejects assertQueue с другими args - Plan 05-01 создал queue без
  // DLX args, поэтому delete-and-recreate. ifUnused:false и ifEmpty:false:
  // снести даже если consumer'ы или сообщения есть (для defense-time idempotency).
  // если queue не существует - первый старт, deleteQueue 404 ловим в catch.
  try {
    await ch.deleteQueue(QUEUE_STOCK_LOW, { ifUnused: false, ifEmpty: false });
  } catch (e) {
    // queue не существовала - ok, первый старт
  }

  await ch.assertQueue(QUEUE_STOCK_LOW, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": DLX_EXCHANGE,
      "x-dead-letter-routing-key": QUEUE_STOCK_LOW,
    },
  });

  // main exchange + bind тот же что и в Plan 05-01
  await ch.assertExchange(WAREHOUSE_EXCHANGE, "topic", { durable: true });
  await ch.bindQueue(QUEUE_STOCK_LOW, WAREHOUSE_EXCHANGE, ROUTING_KEY_STOCK_LOW);

  // prefetch(1) - T-05-09 mitigation
  await ch.prefetch(1);

  await ch.consume(
    QUEUE_STOCK_LOW,
    async (msg) => {
      if (msg === null) return;

      // at-least-once: после restart консумера broker re-deliver'нёт unacked msg
      // с redelivered=true. дубликат email возможен; deduplication out of scope.
      if (msg.fields.redelivered) {
        const pid = tryParseProductId(msg.content.toString());
        console.log(
          "[notification-service] message redelivered redelivered=true - at-least-once delivery, processing again productId=" +
            (pid ?? "unknown"),
        );
      }

      // парс JSON + zod validate. оба гейта up-front: после этого работаем
      // только с типизированным event.
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.content.toString());
      } catch (e) {
        console.error(
          "[notification-service] invalid message (routing to DLX): json parse failed:",
          e,
        );
        ch.nack(msg, false, false);
        notifications_consumed_total.inc({ result: "validation_error" });
        return;
      }

      const result = StockLowEventSchema.safeParse(parsed);
      if (!result.success) {
        console.error(
          "[notification-service] invalid message (routing to DLX):",
          JSON.stringify(result.error.issues),
        );
        // nack(allUpTo=false, requeue=false) - DLX подхватит. requeue:true
        // создал бы бесконечный цикл (T-05-08).
        ch.nack(msg, false, false);
        notifications_consumed_total.inc({ result: "validation_error" });
        return;
      }

      const event = result.data;
      console.log(
        "[notification-service] LOW STOCK productId=" +
          event.productId +
          " warehouseId=" +
          event.warehouseId +
          " available=" +
          event.available +
          " threshold=" +
          event.threshold,
      );

      // email - non-fatal: T-05-13 mitigation. ack всё равно, иначе redelivery spiral.
      try {
        await sendLowStockEmail(event);
        ch.ack(msg);
        notifications_consumed_total.inc({ result: "success" });
      } catch (e) {
        console.error(
          "[notification-service] email send failed (non-fatal):",
          e,
        );
        ch.ack(msg);
        notifications_consumed_total.inc({ result: "email_error" });
      }
    },
    { noAck: false },
  );

  // unexpected connection close (broker restart, network drop) - re-entry в
  // retry loop с attempt=1. INITIAL_RETRY_DELAY_MS дать брокеру встать,
  // дальше startConsumerWithRetry сам растянет backoff если broker всё ещё down.
  conn.on("close", () => {
    console.warn(
      "[notification-service] RabbitMQ connection closed unexpectedly; reconnecting...",
    );
    setTimeout(() => startConsumerWithRetry(1), INITIAL_RETRY_DELAY_MS);
  });

  console.log(
    "[notification-service] consumer started with DLX queue=" +
      QUEUE_STOCK_LOW +
      " dlx=" +
      DLX_EXCHANGE,
  );
}

// public entry point. wraps startConsumer in exponential backoff retry loop.
// terminal case (attempt >= MAX_RETRIES) -> process.exit(1), container restart
// policy (restart:unless-stopped) handles full recovery.
export async function startConsumerWithRetry(attempt = 1): Promise<void> {
  try {
    await startConsumer();
  } catch (e) {
    if (attempt >= MAX_RETRIES) {
      console.error(
        "[notification-service] FATAL: max RabbitMQ reconnect attempts reached, exiting",
      );
      process.exit(1);
    }
    const delay =
      INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
    console.warn(
      "[notification-service] RabbitMQ connection lost, retrying in " +
        delay +
        "ms (attempt " +
        attempt +
        "/" +
        MAX_RETRIES +
        ")",
    );
    setTimeout(() => startConsumerWithRetry(attempt + 1), delay);
  }
}
