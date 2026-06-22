import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

// 轻量静态服务器，用于本地预览原生 ES module 项目。
// 不引入打包器，项目文件会按目录结构直接提供给浏览器。
const root = process.cwd();
const port = Number(process.env.PORT ?? 4173);

// 明确常用文件类型，确保浏览器按 UTF-8 解析中文和 ES module。
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root, requestedPath));

  // 防止通过 ../ 访问项目目录之外的文件。
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    // 只做静态文件读取；找不到文件时返回 404。
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream"
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, () => {
  console.log(`Dinosaur hex evolution running at http://localhost:${port}`);
});
