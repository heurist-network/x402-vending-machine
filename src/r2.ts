import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
  },
  forcePathStyle: true
});

export async function uploadMetadataJson(key: string, obj: any): Promise<string> {
  const Body = Buffer.from(JSON.stringify(obj, null, 2));
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: key,
    Body,
    ContentType: "application/json"
  }));
  return `${process.env.R2_PUBLIC_BASE}/${key}`;
}

export function tokenMetadataKey(tokenLower: string) {
  return `tokens/${tokenLower}.json`;
}
