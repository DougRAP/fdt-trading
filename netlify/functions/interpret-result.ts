/**
 * Result endpoint for the background interpreter job.
 *
 * The browser polls this with the job id it posted. It reads the job blob with strong consistency and
 * returns it unchanged: running, done with the validated result, or failed with a reason. It never
 * calls the model, never touches the key, and never returns anything the runner did not write.
 */
import { getStore } from "@netlify/blobs";
import { JOB_ID_PATTERN, JOB_STORE, jobKey, type BlobStoreLike, type JobBlob, type StoreFactory } from "./interpret";

export const config = { path: "/api/interpret/result" };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const defaultStoreFactory: StoreFactory = () => getStore(JOB_STORE) as unknown as BlobStoreLike;

export function createResultHandler(storeFactory: StoreFactory = defaultStoreFactory) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") return json({ ok: false, reason: "GET only", status: 405 }, 405);
    const jobId = new URL(req.url).searchParams.get("jobId");
    if (jobId === null || !JOB_ID_PATTERN.test(jobId)) {
      return json({ ok: false, reason: "jobId must be an interpreter event id of at most 200 characters", status: 400 }, 400);
    }
    let blob: JobBlob | null;
    try {
      blob = (await storeFactory().get(jobKey(jobId), { type: "json", consistency: "strong" })) as JobBlob | null;
    } catch {
      return json({ ok: false, reason: "could not read the job store", status: 502 }, 502);
    }
    if (!blob) return json({ ok: false, reason: "no such job yet", status: 404 }, 404);
    return json(blob, 200);
  };
}

export default createResultHandler();
