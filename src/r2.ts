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

const cache: Record<string, { data: any; expiry: number }> = {};
const CACHE_TTL = 5 * 60 * 1000;

export async function uploadMetadataJson(key: string, obj: any): Promise<string> {
  const Body = Buffer.from(JSON.stringify(obj, null, 2));
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: key,
    Body,
    ContentType: "application/json"
  }));
  delete cache[key];
  return `${process.env.R2_PUBLIC_BASE}/${key}`;
}

export async function getMetadataJson(key: string): Promise<any> {
  const now = Date.now();
  if (cache[key] && cache[key].expiry > now) {
    return cache[key].data;
  }
  const url = `${process.env.R2_PUBLIC_BASE}/${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("metadata_not_found");
  const data = await res.json();
  cache[key] = { data, expiry: now + CACHE_TTL };
  return data;
}

export function tokenMetadataKey(tokenLower: string) {
  return `tokens/${tokenLower}.json`;
}
