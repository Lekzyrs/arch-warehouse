import nodemailer from "nodemailer";
import { StockLowEvent } from "../../shared-contracts/src/messaging";

// Mailpit - anonymous SMTP sink, без auth и без TLS. defaults подобраны под
// docker-compose service name (mailpit:1025) - локально/в compose работает,
// snake-case env vars override для dev-запуска.
const MAILPIT_SMTP_HOST = process.env.MAILPIT_SMTP_HOST ?? "mailpit";
const MAILPIT_SMTP_PORT = parseInt(
  process.env.MAILPIT_SMTP_PORT ?? "1025",
  10,
);
const NOTIFICATION_EMAIL_TO =
  process.env.NOTIFICATION_EMAIL_TO ?? "admin@archfinal.local";
const NOTIFICATION_EMAIL_FROM = "warehouse@archfinal.local";

// module-level singleton transporter - не пересоздавать на каждое письмо
const transporter = nodemailer.createTransport({
  host: MAILPIT_SMTP_HOST,
  port: MAILPIT_SMTP_PORT,
  secure: false,
  ignoreTLS: true,
});

// EDA-04: отправка email через Mailpit SMTP. caller (consumer.ts) ловит ошибку
// в try/catch и считает её non-fatal: increments email_error metric и acks.
// не логировать MAILPIT_SMTP_HOST и URL - T-05-11 mitigation.
export async function sendLowStockEmail(event: StockLowEvent): Promise<void> {
  const text =
    "Low stock detected.\n\n" +
    "Product: " +
    event.productId +
    "\nWarehouse: " +
    event.warehouseId +
    "\nAvailable: " +
    event.available +
    "\nThreshold: " +
    event.threshold +
    "\nAggregate: " +
    event.aggregateId +
    "\nTime: " +
    event.occurredAt;

  await transporter.sendMail({
    from: NOTIFICATION_EMAIL_FROM,
    to: NOTIFICATION_EMAIL_TO,
    subject: "Low Stock Alert: " + event.productId,
    text,
  });

  console.log(
    "[notification-service] email sent to=" +
      NOTIFICATION_EMAIL_TO +
      " productId=" +
      event.productId,
  );
}
