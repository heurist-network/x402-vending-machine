import { NotificationType } from "./notification-types";
import { sendSlackNotification } from "./slack";

const completedNotifications = new Map<string, Set<NotificationType>>();

export async function notify(tokenAddress: string, notificationType: NotificationType) {
  const tokenLower = tokenAddress.toLowerCase();

  if (!completedNotifications.has(tokenLower)) {
    completedNotifications.set(tokenLower, new Set());
  }

  const tokenNotifications = completedNotifications.get(tokenLower)!;

  if (tokenNotifications.has(notificationType)) {
    return;
  }

  tokenNotifications.add(notificationType);
  await sendSlackNotification(tokenLower, notificationType);
}
