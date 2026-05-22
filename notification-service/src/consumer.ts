import amqp from "amqplib";
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
import {
  lowStockAlertsCounter,
  stockEventsConsumedCounter,
} from "./metrics/registry";

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

// reconnect state в module scope - единая точка истины. предотвращает гонку
// между catch path в startConsumerWithRetry и conn.on('close'): оба попадают
// в scheduleConsumerReconnect, но реальный setTimeout запускается ровно один.
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let intentionallyClosed = false;

// текущие connection/channel в module scope - SIGTERM в index.ts закрывает их
// через closeConsumer(), чтобы не потерять in-flight сообщения.
let conn: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

// zod-валидация payload - первый и единственный гейт между брокером и
// побочными эффектами (email, metrics, log). T-05-07/T-05-08 mitigation.
// int().nonnegative() / int().positive() - poisoned producer с available=-1
// или fractional 0.5 уйдёт в DLQ, а не сгенерирует бессмысленный email.
const StockLowEventSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  available: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  aggregateId: z.string().min(1),
  occurredAt: z.string(),
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

  const newConn = await amqp.connect(url);
  const ch = await newConn.createChannel();

  // DLX-инфраструктура поднимается первой - direct exchange + durable DLQ,
  // DLQ привязан к DLX по routing-key равному имени main queue
  // (x-dead-letter-routing-key ниже зеркалит это).
  await ch.assertExchange(DLX_EXCHANGE, "direct", { durable: true });
  await ch.assertQueue(DLQ_QUEUE, { durable: true });
  await ch.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, QUEUE_STOCK_LOW);

  // queue assert-first, delete-on-406 only. предыдущая логика unconditionally
  // делала deleteQueue на КАЖДЫЙ (re)connect - broker restart терял unacked
  // сообщения которые иначе redelivered'нулись бы. сейчас: пробуем assertQueue
  // с актуальными args; если broker отвечает 406 PRECONDITION_FAILED (queue
  // существует с другими args - migration scenario из Plan 05-01) - открываем
  // fresh channel (failed канал уже закрыт брокером), сносим, re-assert.
  const queueArgs = {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": DLX_EXCHANGE,
      "x-dead-letter-routing-key": QUEUE_STOCK_LOW,
    },
  };
  let workingCh = ch;
  try {
    await workingCh.assertQueue(QUEUE_STOCK_LOW, queueArgs);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 406) throw err;
    console.warn(
      "[notification-service] queue exists with incompatible args (406); deleting and re-asserting once",
    );
    const ch2 = await newConn.createChannel();
    await ch2.deleteQueue(QUEUE_STOCK_LOW, { ifUnused: false, ifEmpty: false });
    await ch2.assertQueue(QUEUE_STOCK_LOW, queueArgs);
    workingCh = ch2;
  }

  // main exchange + bind тот же что и в Plan 05-01
  await workingCh.assertExchange(WAREHOUSE_EXCHANGE, "topic", { durable: true });
  await workingCh.bindQueue(
    QUEUE_STOCK_LOW,
    WAREHOUSE_EXCHANGE,
    ROUTING_KEY_STOCK_LOW,
  );

  // prefetch(1) - T-05-09 mitigation
  await workingCh.prefetch(1);

  await workingCh.consume(
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
        workingCh.nack(msg, false, false);
        // OBS-03: считаем КАЖДУЮ доставку (включая poisoned payload) - метрика
        // отражает физическое потребление с очереди. low_stock_alerts_total
        // ниже инкрементится только на успешном email path, разница = ошибки.
        stockEventsConsumedCounter.inc({ event_type: ROUTING_KEY_STOCK_LOW });
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
        workingCh.nack(msg, false, false);
        stockEventsConsumedCounter.inc({ event_type: ROUTING_KEY_STOCK_LOW });
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
        workingCh.ack(msg);
        stockEventsConsumedCounter.inc({ event_type: ROUTING_KEY_STOCK_LOW });
        // low_stock_alerts_total инкрементится ТОЛЬКО на успешном email.
        // email_error path ниже не вызывает .inc - алёрт не доехал до пользователя.
        lowStockAlertsCounter.inc();
      } catch (e) {
        console.error(
          "[notification-service] email send failed (non-fatal):",
          e,
        );
        workingCh.ack(msg);
        stockEventsConsumedCounter.inc({ event_type: ROUTING_KEY_STOCK_LOW });
      }
    },
    { noAck: false },
  );

  // только ПОСЛЕ успешного ch.consume публикуем conn/ch в module scope и
  // вешаем close-handler. если consume() выше throw'нул, conn.on('close')
  // НЕ будет привязан, поэтому единственный путь reconnect - catch в
  // startConsumerWithRetry. это убирает гонку двух scheduler'ов.
  conn = newConn;
  channel = workingCh;
  reconnectAttempt = 0;

  newConn.on("close", () => {
    console.warn(
      "[notification-service] RabbitMQ connection closed unexpectedly; reconnecting...",
    );
    conn = null;
    channel = null;
    scheduleConsumerReconnect();
  });

  console.log(
    "[notification-service] consumer started with DLX queue=" +
      QUEUE_STOCK_LOW +
      " dlx=" +
      DLX_EXCHANGE,
  );
}

// single-flight reconnect scheduler. оба пути (catch в startConsumerWithRetry,
// conn.on('close')) идут сюда, реальный setTimeout запускается ровно один -
// reconnectTimer guard. attempt держится в module scope, MAX_RETRIES enforced
// глобально (а не per-call как в старой реализации).
function scheduleConsumerReconnect(): void {
  if (intentionallyClosed) return;
  if (reconnectTimer) return;
  if (reconnectAttempt >= MAX_RETRIES) {
    console.error(
      "[notification-service] FATAL: max RabbitMQ reconnect attempts reached, exiting",
    );
    process.exit(1);
  }
  reconnectAttempt += 1;
  const delay =
    INITIAL_RETRY_DELAY_MS *
    Math.pow(BACKOFF_MULTIPLIER, reconnectAttempt - 1);
  console.warn(
    "[notification-service] RabbitMQ connection lost, retrying in " +
      delay +
      "ms (attempt " +
      reconnectAttempt +
      "/" +
      MAX_RETRIES +
      ")",
  );
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await startConsumer();
    } catch (e) {
      console.error(
        "[notification-service] consumer reconnect attempt failed:",
        e,
      );
      scheduleConsumerReconnect();
    }
  }, delay);
}

// public entry point. первая попытка - синхронная (await), дальнейшие через
// scheduleConsumerReconnect. attempt-параметр убран: state в module scope.
export async function startConsumerWithRetry(): Promise<void> {
  try {
    await startConsumer();
  } catch (e) {
    console.error("[notification-service] initial consumer start failed:", e);
    scheduleConsumerReconnect();
  }
}

// SIGTERM handler в index.ts вызывает closeConsumer() - закрываем channel и
// connection чтобы in-flight сообщения корректно завершились/redelivered'нулись
// после перезапуска. intentionallyClosed guard блокирует reconnect-timer.
export async function closeConsumer(): Promise<void> {
  intentionallyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    await channel?.close();
  } catch (e) {
    console.warn(
      "[notification-service] channel close error:",
      (e as Error).message,
    );
  }
  try {
    await conn?.close();
  } catch (e) {
    console.warn(
      "[notification-service] connection close error:",
      (e as Error).message,
    );
  }
  channel = null;
  conn = null;
  console.log("[notification-service] consumer closed");
}
