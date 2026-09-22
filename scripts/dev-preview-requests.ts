import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export function isSandboxedPreviewRead(request: IncomingMessage): boolean {
  if (!["GET", "HEAD"].includes(request.method ?? "")) return false;
  if (request.headers["sec-fetch-site"] !== "cross-site") return false;
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/reader-assets/")) return true;
  return (
    /^\/api\/manage\/books\/[1-9][0-9]*\/preview\/ver_[A-Za-z0-9_-]{16,80}\/assets\/res_[A-Za-z0-9_-]{16,80}$/u.test(
      url.pathname,
    ) && Boolean(url.searchParams.get("authorization"))
  );
}

export function sandboxedPreviewRequests(): Plugin {
  return {
    name: "mirawind-sandboxed-preview-reads",
    apply: "serve",
    enforce: "post",
    configureServer(server) {
      return () =>
        server.middlewares.stack.unshift({
          route: "",
          handle: (
            request: IncomingMessage,
            _response: ServerResponse,
            next: () => void,
          ) => {
            // Astro's dev guard cannot represent an opaque sandbox origin. These read-only
            // routes explicitly allow cross-origin use; their own asset/token guards still run.
            if (isSandboxedPreviewRead(request))
              delete request.headers["sec-fetch-site"];
            next();
          },
        });
    },
  };
}
