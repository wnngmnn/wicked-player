import { createFileRoute } from "@tanstack/react-router";

const MAX = 95 * 1024 * 1024;
const NAME = /^wicked-[0-9a-f-]{36}-part-\d{3}-of-\d{1,3}\.zip$/;
const json = (body: unknown, status = 200) => Response.json(body, { status });

export const Route = createFileRoute("/api/public/share-upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["PIXELDRAIN_API_KEY"];
        if (!key) return json({ error: "Sharing isn't set up yet." }, 503);
        const name = new URL(request.url).searchParams.get("name") ?? "";
        if (!NAME.test(name)) return json({ error: "Invalid album part." }, 400);
        const len = Number(request.headers.get("content-length"));
        if (!Number.isFinite(len) || len < 22 || len > MAX) return json({ error: "Album part is too large." }, 413);
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.length !== len || body[0] !== 0x50 || body[1] !== 0x4b) return json({ error: "Only Wicked album ZIPs can be shared." }, 400);
        const res = await fetch(`https://pixeldrain.com/api/file/${name}`, {
          method: "PUT", body, headers: { Authorization: `Basic ${btoa(":" + key)}` },
        });
        const data = (await res.json().catch(() => null)) as { id?: string; value?: string } | null;
        if (!res.ok || !data?.id) {
          console.error("pixeldrain upload failed", res.status, data?.value);
          return json({ error: "The file host rejected the upload. Try again later." }, 502);
        }
        return json({ id: data.id });
      },
    },
  },
});
