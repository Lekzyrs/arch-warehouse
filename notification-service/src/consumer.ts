import amqp from "amqplib";
import {
  QUEUE_STOCK_LOW,
  ROUTING_KEY_STOCK_LOW,
  StockLowEvent,
  WAREHOUSE_EXCHANGE,
} from "../../shared-contracts/src/messaging";
import { RABBIT_CONFIG } from "../../shared-contracts/src/rabbitmq-config";

// EDA-01/EDA-03 consumer. plain durable queue без DLX binding - DLX добавляется
// в plan 05-02. сейчас вытащить wire end-to-end: connect, assert, bind, consume,
// log. prefetch(1) + manual ack (noAck:false) - база под durable consumer.
export async function startConsumer(): Promise<void> {
  const url = process.env.RABBITMQ_URL ?? RABBIT_CONFIG.url;
  if (!url) {
    throw new Error("RABBITMQ_URL env var is required");
  }

  const conn = await amqp.connect(url);
  const ch = await conn.createChannel();

  // та же топология что у publisher (shared-contracts), durable топик exchange
  await ch.assertExchange(WAREHOUSE_EXCHANGE, "topic", { durable: true });
  // durable queue. DLX args (x-dead-letter-exchange) - plan 05-02
  await ch.assertQueue(QUEUE_STOCK_LOW, { durable: true });
  await ch.bindQueue(QUEUE_STOCK_LOW, WAREHOUSE_EXCHANGE, ROUTING_KEY_STOCK_LOW);

  // prefetch(1) - один in-flight message, нет flood при медленной обработке
  await ch.prefetch(1);

  await ch.consume(
    QUEUE_STOCK_LOW,
    (msg) => {
      if (msg === null) return;
      try {
        const event: StockLowEvent = JSON.parse(msg.content.toString());
        console.log(
          `[notification-service] LOW STOCK productId=${event.productId} warehouseId=${event.warehouseId} available=${event.available} threshold=${event.threshold}`,
        );
        ch.ack(msg);
      } catch (e) {
        console.error("[notification-service] failed to parse message:", e);
        // nack(allUpTo=false, requeue=false) - сейчас drop. в plan 05-02 DLX
        // подхватит poison message в DLQ вместо drop.
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  console.log(
    `[notification-service] consumer started queue=${QUEUE_STOCK_LOW}`,
  );
}
