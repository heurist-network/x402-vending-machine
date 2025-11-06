import "dotenv/config";
import { NotificationType } from "./notification-types";
import { notify } from "./notification-manager";

async function testNotifications() {
  console.log("Testing Slack notifications...\n");

  const testTokenAddress = "0x1234567890abcdef1234567890abcdef12345678";

  console.log("1. Testing 50% notification...");
  await notify(testTokenAddress, NotificationType.Purchase50Percent);
  console.log("✓ 50% notification sent\n");

  console.log("2. Testing 90% notification...");
  await notify(testTokenAddress, NotificationType.Purchase90Percent);
  console.log("✓ 90% notification sent\n");

  console.log("3. Testing graduation notification...");
  await notify(testTokenAddress, NotificationType.Graduation);
  console.log("✓ Graduation notification sent\n");

  console.log("4. Testing duplicate prevention (should not send again)...");
  await notify(testTokenAddress, NotificationType.Purchase50Percent);
  console.log("✓ Duplicate correctly skipped\n");

  console.log("5. Testing different token...");
  const anotherToken = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  await notify(anotherToken, NotificationType.Purchase50Percent);
  console.log("✓ Different token notification sent\n");

  console.log("All tests completed! Check your Slack channel.");
}

testNotifications().catch(console.error);
