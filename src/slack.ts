import { NotificationType } from "./notification-types";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function sendSlackNotification(tokenAddress: string, notificationType: NotificationType) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("SLACK_WEBHOOK_URL not configured, skipping notification");
    return;
  }

  const message = formatNotificationMessage(tokenAddress, notificationType);

  await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message })
  });
}

function formatNotificationMessage(tokenAddress: string, notificationType: NotificationType): string {
  if (notificationType === NotificationType.Purchase50Percent) {
    return `Token ${tokenAddress} has reached 50% sold`;
  }
  if (notificationType === NotificationType.Purchase90Percent) {
    return `Token ${tokenAddress} has reached 90% sold`;
  }
  if (notificationType === NotificationType.Graduation) {
    return `Token ${tokenAddress} has graduated - liquidity added`;
  }
  return `Token ${tokenAddress} notification: ${notificationType}`;
}
