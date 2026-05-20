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

export async function startConsumer(): Promise<void> {
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

  console.log(
    "[notification-service] consumer started with DLX queue=" +
      QUEUE_STOCK_LOW +
      " dlx=" +
      DLX_EXCHANGE,
  );
}
