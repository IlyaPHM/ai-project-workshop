/* Browser helper. The code is entered by the student, never hardcoded here. */
class ClassroomAI {
  constructor(baseUrl, accessCode) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Адрес API должен начинаться с https://');
    if (url.username || url.password || url.search || url.hash) throw new Error('Укажи обычный адрес API без пароля, параметров и #.');
    if (!accessCode.trim()) throw new Error('Введи свой код доступа.');
    this.baseUrl = url.origin;
    this.accessCode = accessCode.trim();
  }
  async request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      const response = await fetch(this.baseUrl + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + this.accessCode, ...(body ? {'Content-Type':'application/json'} : {}) },
        ...(body ? {body:JSON.stringify(body)} : {}),
        signal:controller.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error?.message || 'Ошибка API: ' + response.status);
        error.status = response.status;error.code = data.error?.code;error.retryAfter = Number(response.headers.get('Retry-After') || 0);
        throw error;
      }
      return data;
    } catch(error) {
      if (error.name === 'AbortError') throw new Error('Сервис долго не отвечает. Проверь подключение и повтори позже.');
      throw error;
    } finally {clearTimeout(timer);}
  }
  async chat(project, messages, instructions = '') { return this.request('/v1/chat',{project,messages,instructions}); }
  async usage() { return this.request('/v1/usage'); }
}
if (typeof window !== 'undefined') window.ClassroomAI = ClassroomAI;
