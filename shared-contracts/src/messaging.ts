// единый источник топологии RabbitMQ. публишер (stock-service) и консумер
// (notification-service) импортируют отсюда - топология не может разойтись.

export const WAREHOUSE_EXCHANGE = "warehouse.exchange";
export const ROUTING_KEY_STOCK_LOW = "stock.low";
export const QUEUE_STOCK_LOW = "stock.low.notifications";
export const DLX_EXCHANGE = "warehouse.dlx";
export const DLQ_QUEUE = "stock.low.dlq";

// payload событий stock.low. occurredAt - ISO-строка чтобы JSON.parse не терял Date
export interface StockLowEvent {
  productId: string;
  warehouseId: string;
  locationId?: string;
  available: number;
  threshold: number;
  aggregateId: string;
  occurredAt: string;
}
