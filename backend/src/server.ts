import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';

createApp({ enableCors: false }).listen(port, host, () => {
  console.log(`H5 SCORM Editor API: http://${host}:${port}`);
});
