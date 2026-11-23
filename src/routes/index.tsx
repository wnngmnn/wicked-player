import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

const App = lazy(() => import("@/app/App"));

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "Wicked — Local Music & Album Sharing" },
    { name: "description", content: "Play your local music with Wicked. Share albums with original-quality MP3s, cover art and lyrics, and import them into your own music folder." },
    { property: "og:title", content: "Wicked — Local Music & Album Sharing" },
    { property: "og:description", content: "Your music stays local. Package and share albums, then import them into your own library." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: Index,
});

function Index() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="min-h-screen bg-background" />;
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <App />
    </Suspense>
  );
}
