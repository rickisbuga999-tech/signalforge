const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ROOT = __dirname;
const MAX_BYTES = 13 * 1024 * 1024;

function send(res, status, data, type='application/json; charset=utf-8') {
  res.writeHead(status, {'Content-Type': type, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store'});
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('Некорректный формат загрузки изображения.');
  const boundary = Buffer.from('--' + (boundaryMatch[1] || boundaryMatch[2]));
  const parts = [];
  let cursor = 0;
  while (true) {
    const at = buffer.indexOf(boundary, cursor);
    if (at < 0) break;
    let start = at + boundary.length;
    if (buffer[start] === 45 && buffer[start+1] === 45) break;
    if (buffer[start] === 13 && buffer[start+1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd < 0) break;
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    let bodyEnd = next;
    if (buffer[bodyEnd-2] === 13 && buffer[bodyEnd-1] === 10) bodyEnd -= 2;
    const headers = buffer.subarray(start, headerEnd).toString('utf8');
    const body = buffer.subarray(headerEnd + 4, bodyEnd);
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
    if (name) parts.push({name, filename, mime, body});
    cursor = next;
  }
  return parts;
}
function extractText(payload) {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) return c.text;
  return '';
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, {ok:true, aiConfigured:Boolean(API_KEY), model:MODEL});
  }
  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    if (!API_KEY) return send(res, 503, {error:'AI-модель не настроена: добавьте OPENAI_API_KEY в переменные окружения сервера.'});
    const chunks=[]; let total=0;
    try {
      for await (const chunk of req) { total += chunk.length; if (total > MAX_BYTES) { send(res, 413, {error:'Файл слишком большой. Максимальный размер — 12 МБ.'}); req.destroy(); return; } chunks.push(chunk); }
      const parts = parseMultipart(Buffer.concat(chunks), req.headers['content-type']);
      const image = parts.find(p=>p.name==='image');
      const horizon = parts.find(p=>p.name==='horizon')?.body.toString('utf8') || 'не указан';
      const allowed = {'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'};
      if (!image || !image.filename || !allowed[image.mime]) return send(res, 400, {error:'Загрузите корректный PNG, JPG или WEBP.'});
      if (!image.body.length || image.body.length > 12*1024*1024) return send(res, 413, {error:'Размер изображения должен быть не более 12 МБ.'});
      const dataUrl = `data:${image.mime};base64,${image.body.toString('base64')}`;
      const instructions = `Ты — помощник по визуальному разбору биржевых графиков. Проанализируй только то, что реально видно на изображении. Выбранный пользователем горизонт: ${horizon}. Это горизонт предполагаемого сценария, не обязательно таймфрейм свечей. Не утверждай, что знаешь будущие цены. Если график нечитаем, нет видимых свечей/шкалы, либо основания слабые, выбери «НЕДОСТАТОЧНО ДАННЫХ» и низкую уверенность. Разрешённые значения signal: «ПОКУПКА», «ПРОДАЖА», «НЕТ СДЕЛКИ», «НЕДОСТАТОЧНО ДАННЫХ». confidence — субъективная уверенность именно в визуальной интерпретации, не вероятность прибыли; не завышай её. Не выдумывай тикер, цену, индикаторы, таймфрейм или уровни, если их нельзя прочитать. Обязательно укажи риски и необходимость проверки актуальных котировок. Ответь ТОЛЬКО валидным JSON с ключами signal, confidence (число 0-100 или null), summary (строка), reasons (массив 2-4 объектов с title и detail), risk_note (строка). Не давай обещаний доходности и не выдавай это за персональную финансовую рекомендацию.`;
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method:'POST', headers:{'Authorization':`Bearer ${API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:MODEL, input:[{role:'user',content:[{type:'input_text',text:instructions},{type:'input_image',image_url:dataUrl,detail:'high'}]}], max_output_tokens:900})
      });
      const payload = await upstream.json().catch(()=>({}));
      if (!upstream.ok) {
        const msg = payload.error?.message || `AI API вернул ошибку (${upstream.status}).`;
        return send(res, 502, {error: upstream.status===401 ? 'API-ключ не принят. Проверьте OPENAI_API_KEY на сервере.' : msg});
      }
      const text = extractText(payload);
      let result;
      try { result = JSON.parse(text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
      catch { return send(res, 502, {error:'AI вернул ответ в неожиданном формате. Повторите анализ.'}); }
      const allowedSignals = ['ПОКУПКА','ПРОДАЖА','НЕТ СДЕЛКИ','НЕДОСТАТОЧНО ДАННЫХ'];
      if (!allowedSignals.includes(result.signal)) result.signal='НЕДОСТАТОЧНО ДАННЫХ';
      if (!(result.confidence === null || (Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 100))) result.confidence=null;
      if (!Array.isArray(result.reasons)) result.reasons=[];
      result.reasons=result.reasons.slice(0,4).map(r=>({title:String(r.title||'Наблюдение').slice(0,160),detail:String(r.detail||'').slice(0,700)}));
      result.summary=String(result.summary||'Визуальный разбор графика завершён.').slice(0,1000);
      result.risk_note=String(result.risk_note||'Это визуальная интерпретация одного скриншота, а не прогноз с гарантией результата.').slice(0,1000);
      result.model=MODEL;
      return send(res, 200, result);
    } catch (e) {
      console.error('analysis error:', e.message);
      if (!res.headersSent) return send(res, 500, {error:'Внутренняя ошибка сервера при анализе изображения.'});
    }
  }
  if (req.method === 'GET') {
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const full = path.resolve(ROOT, requested);
    if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT,'index.html')) return send(res,404,{error:'Not found'});
    fs.readFile(full,(err, data)=>{
      if (err) return send(res,404,{error:'Файл не найден'});
      const ext=path.extname(full);
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
      send(res,200,data,types[ext]||'application/octet-stream');
    });
    return;
  }
  send(res,404,{error:'Not found'});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`SignalForge listening on port ${PORT}; model=${MODEL}; API key configured=${Boolean(API_KEY)}`));
