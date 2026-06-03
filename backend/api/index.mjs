import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const BUCKET = process.env.STORAGE_BUCKET;
const WORKER_FN = process.env.WORKER_FUNCTION;

const s3 = new S3Client({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

function extFromMedia(m) {
  if (!m) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "jpg";
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const rawPath = event.requestContext?.http?.path || event.rawPath || "";

  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    // POST /upload-url -> presigned PUT URL so the browser uploads the FULL-RES original to S3
    if (method === "POST" && rawPath.endsWith("/upload-url")) {
      const body = JSON.parse(event.body || "{}");
      const { filename, mediaType } = body;
      const jobId = randomUUID();
      const ext = extFromMedia(mediaType);
      const key = `uploads/${jobId}.${ext}`;
      const putCmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: mediaType || "image/jpeg" });
      const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 900 });
      return json(200, { jobId, key, uploadUrl, filename });
    }

    // POST /process -> after upload, trigger the worker
    if (method === "POST" && rawPath.endsWith("/process")) {
      const body = JSON.parse(event.body || "{}");
      const { jobId, key, filename } = body;
      if (!jobId || !key) return json(400, { error: "jobId and key required" });

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `results/${jobId}.json`,
        Body: JSON.stringify({ status: "processing", jobId, filename }),
        ContentType: "application/json",
      }));

      await lambda.send(new InvokeCommand({
        FunctionName: WORKER_FN,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ jobId, key, filename })),
      }));

      return json(202, { jobId, filename, status: "processing" });
    }

    // GET /result/{jobId}
    if (method === "GET" && rawPath.includes("/result/")) {
      const jobId = rawPath.split("/result/")[1];
      if (!jobId) return json(400, { error: "jobId required" });
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `results/${jobId}.json` }));
        const text = await streamToString(obj.Body);
        return json(200, JSON.parse(text));
      } catch (e) {
        if (e.name === "NoSuchKey") return json(404, { status: "not_found", jobId });
        throw e;
      }
    }

    return json(404, { error: "Not found", path: rawPath });
  } catch (err) {
    console.error("API error:", err);
    return json(500, { error: String(err?.message || err) });
  }
};
