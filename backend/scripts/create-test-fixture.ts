import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const fixtureRoot = path.resolve('test-fixtures');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA' +
  'B3RJTUUH6AUBAAAVdQhXqAAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCBmb3IgdGVzdGluZ5w9' +
  'xJgAAABASURBVHja7cEBAQAAAIIg/69uSEABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAADwGxPgAAE3xV/6AAAAAElFTkSuQmCC',
  'base64',
);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>测试 H5 课程</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <main class="course-card">
    <p class="eyebrow">内部学习课程</p>
    <h1>人工智能教育发展趋势</h1>
    <p>点击标题可直接编辑，选择图片后可执行替换。</p>
    <img src="images/test.png" alt="测试课程封面">
  </main>
</body>
</html>`;
const css = `* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #eef2ff; color: #172033; }
.course-card { width: min(760px, 90vw); padding: 56px; border-radius: 24px; background: white; box-shadow: 0 24px 80px rgba(41, 51, 92, .16); }
.eyebrow { color: #635bff; font-weight: 700; }
h1 { margin: 8px 0 16px; font-size: 42px; }
img { display: block; width: 100%; height: 280px; margin-top: 28px; object-fit: cover; border-radius: 16px; background: #ddd6fe; }
`;

await mkdir(path.join(fixtureRoot, 'course', 'css'), { recursive: true });
await mkdir(path.join(fixtureRoot, 'course', 'images'), { recursive: true });
await writeFile(path.join(fixtureRoot, 'course', 'index.html'), html, 'utf8');
await writeFile(path.join(fixtureRoot, 'course', 'css', 'style.css'), css, 'utf8');
await writeFile(path.join(fixtureRoot, 'course', 'images', 'test.png'), png);

const zip = new JSZip();
zip.file('course/index.html', html);
zip.file('course/css/style.css', css);
zip.file('course/images/test.png', png);
await writeFile(path.join(fixtureRoot, 'course.zip'), await zip.generateAsync({ type: 'nodebuffer' }));
console.log(`测试课程已生成：${path.join(fixtureRoot, 'course.zip')}`);
