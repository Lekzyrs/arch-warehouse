import amqp, { Channel, ChannelModel } from "amqplib";
import {
  ROUTING_KEY_STOCK_LOW,
  StockLowEvent,
  WAREHOUSE_EXCHANGE,
} from "../../../shared-contracts/src/messaging";
import { RABBIT_CONFIG } from "../../../shared-contracts/src/rabbitmq-config";

// module-level singleton. connect() инициализирует, publishStockLow() ругается
// если канал ещё не открыт. heartbeat:0 НЕ передаём - в amqplib 2.x это означает
// "отключить heartbeat" (breaking change), оставляем server-negotiated default.
let connection: ChannelModel | null = null;
let channel: Channel | null = null;

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

  console.log(
    `[stock-service] publisher connected to RabbitMQ exchange=${WAREHOUSE_EXCHANGE}`,
  );
}

export async function publishStockLow(event: StockLowEvent): Promise<void> {
  if (!channel) {
    throw new Error("publisher not connected - call connect() first");
  }

  // deliveryMode:2 - persistent (требование EDA-01). contentType - чтобы консумер
  // знал что внутри JSON и не парсил бинарь.
  channel.publish(
    WAREHOUSE_EXCHANGE,
    ROUTING_KEY_STOCK_LOW,
    Buffer.from(JSON.stringify(event)),
    { deliveryMode: 2, contentType: "application/json" },
  );

  console.log(
    `[stock-service] published stock.low productId=${event.productId} available=${event.available}`,
  );
}

export async function closePublisher(): Promise<void> {
  try {
    await channel?.close();
    await connection?.close();
  } catch {
    // closing best-effort, отдельный error не критичен на shutdown
  }
  channel = null;
  connection = null;
  console.log("[stock-service] publisher closed");
}
