import amqp, { Channel, ChannelModel } from "amqplib";
import {
  ROUTING_KEY_STOCK_LOW,
  StockLowEvent,
  WAREHOUSE_EXCHANGE,
} from "../../../shared-contracts/src/messaging";
import { RABBIT_CONFIG } from "../../../shared-contracts/src/rabbitmq-config";
import { stockEventsPublishedCounter } from "../metrics/registry";

// module-level singleton. connect() инициализирует, publishStockLow() ругается
// если канал ещё не открыт. heartbeat:0 НЕ передаём - в amqplib 2.x это означает
// "отключить heartbeat" (breaking change), оставляем server-negotiated default.
let connection: ChannelModel | null = null;
let channel: Channel | null = null;

// reconnect backoff. exponential: 1s, 2s, 4s, 8s, 16s. после 5 попыток publisher
// "уходит в тишину" (не fatal: projector ловит publish error в try/catch и не
// валит проекцию - см. read/projector.ts). T-05-14 accept: stock-service сам по
// себе работает дальше, теряем только stock.low alerts до восстановления.
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
let reconnectAttempt = 0;
let intentionallyClosed = false;
let reconnectTimer: NodeJS.Timeout | null = null;

// single-flight scheduler. connection.on('error') и channel.on('close') оба
// зовут эту функцию при broker restart, но реальный setTimeout запускается
// один - reconnectTimer guard. без этого создавались параллельные timer'ы,
// два connect() в гонке, leaked listeners.
function schedulePublisherReconnect(): void {
  if (intentionallyClosed) return;
  if (reconnectTimer) return;
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(
      "[stock-service] publisher giving up reconnect attempts; stock.low alerts will not publish until restart",
    );
    return;
  }
  reconnectAttempt += 1;
  const delay =
    INITIAL_RECONNECT_DELAY_MS *
    Math.pow(RECONNECT_BACKOFF_MULTIPLIER, reconnectAttempt - 1);
  console.log(
    "[stock-service] publisher reconnect attempt " +
      reconnectAttempt +
      " in " +
      delay +
      "ms",
  );
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      // закрываем старые объекты перед reassign в connect() - старый channel
      // мог не успеть GC'нуться, leaked listeners складываются между попытками.
      try {
        await channel?.close();
      } catch {
        // close failure не критичен - либо уже закрыт, либо connection dead
      }
      try {
        await connection?.close();
      } catch {
        // same
      }
      channel = null;
      connection = null;
      await connect();
      reconnectAttempt = 0;
      console.log("[stock-service] publisher reconnected");
    } catch (e) {
      console.error("[stock-service] publisher reconnect failed:", e);
      schedulePublisherReconnect();
    }
  }, delay);
}

export async function connect(): Promise<void> {
  // RABBITMQ_URL приоритетнее; иначе собираем url из RABBITMQ_HOST/PORT/USER/PASS
  // (RABBIT_CONFIG.url из shared-contracts - единая точка сборки)
  const url = process.env.RABBITMQ_URL ?? RABBIT_CONFIG.url;
  if (!url) {
    throw new Error("RABBITMQ_URL env var is required");
  }

  connection = await amqp.connect(url);
  channel = await connection.createChannel();

  await channel.assertExchange(WAREHOUSE_EXCHANGE, "topic", { durable: true });

  // reconnect handlers. connection.on('error') ловит сетевые сбои; channel.on
  // ('close') - закрытие канала после restart брокера. оба маршрута сходятся в
  // schedulePublisherReconnect. listener'ы вешаются ПОСЛЕ успешного assert чтобы
  // не дёрнуться на первом подключении.
  connection.on("error", (err: Error) => {
    console.error("[stock-service] RabbitMQ connection error:", err.message);
    schedulePublisherReconnect();
  });
  channel.on("close", () => {
    console.warn("[stock-service] RabbitMQ channel closed; scheduling reconnect");
    connection = null;
    channel = null;
    schedulePublisherReconnect();
  });

  console.log(
    `[stock-service] publisher connected to RabbitMQ exchange=${WAREHOUSE_EXCHANGE}`,
  );
}

export async function publishStockLow(event: StockLowEvent): Promise<void> {
  if (!channel) {
    // во время reconnect ходим в "тишину" а не throw - projector уже оборачивает
    // в try/catch (Plan 05-01), но дополнительная защита здесь оставляет ясный лог.
    console.warn("[stock-service] publish skipped (reconnecting)");
    return;
  }

  // deliveryMode:2 - persistent (требование EDA-01). contentType - чтобы консумер
  // знал что внутри JSON и не парсил бинарь.
  channel.publish(
    WAREHOUSE_EXCHANGE,
    ROUTING_KEY_STOCK_LOW,
    Buffer.from(JSON.stringify(event)),
    { deliveryMode: 2, contentType: "application/json" },
  );

  // OBS-03: метрика после publish (не до) - чтобы счётчик отражал реально
  // отправленные сообщения, а не попытки. при skip-on-no-channel выше return
  // происходит раньше и .inc не вызывается.
  stockEventsPublishedCounter.inc({ event_type: ROUTING_KEY_STOCK_LOW });

  console.log(
    `[stock-service] published stock.low productId=${event.productId} available=${event.available}`,
  );
}

export async function closePublisher(): Promise<void> {
  // выставляем флаг ДО close чтобы channel.on('close') не запустил reconnect
  // на intentional shutdown (SIGTERM из docker compose stop).
  intentionallyClosed = true;
  reconnectAttempt = MAX_RECONNECT_ATTEMPTS;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // channel.close() и connection.close() в раздельных try - если первый
  // throw'нул (например, канал уже закрыт), connection всё равно надо закрыть,
  // иначе TCP соединение висит до broker timeout.
  try {
    await channel?.close();
  } catch (e) {
    console.warn(
      "[stock-service] channel close error:",
      (e as Error).message,
    );
  }
  try {
    await connection?.close();
  } catch (e) {
    console.warn(
      "[stock-service] connection close error:",
      (e as Error).message,
    );
  }
  channel = null;
  connection = null;
  console.log("[stock-service] publisher closed");
}
