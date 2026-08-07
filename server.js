// TF Search API
// -----------------------------------------------------------------------------
// Micro-serviço que resolve o AWS WAF da Tiziana Fausti usando um navegador real
// (Chromium via Playwright) e mantém a sessão logada. O n8n chama este serviço
// com um HTTP Request simples e recebe os produtos já parseados em JSON.
//
// Fluxo interno: mantém 1 navegador "quente" com os cookies de login injetados,
// navega no site (o WAF gera o aws-waf-token sozinho) e roda o fetch do endpoint
// de autocomplete DENTRO da página — exatamente como o navegador do usuário faz.
// -----------------------------------------------------------------------------

import express from "express";
import { chromium } from "playwright";

// ---------- Configuração (via variáveis de ambiente no Railway) --------------
const PORT       = process.env.PORT || 3000;
const API_KEY    = process.env.API_KEY || "";                       // protege o endpoint
const BASE       = (process.env.TF_BASE || "https://www.tizianafausti.net/vip1_en").replace(/\/$/, "");
const STORE_ID   = process.env.TF_STORE_ID || "2";
const RAW_COOKIES= process.env.TF_COOKIES || "";                    // "PHPSESSID=...; X-Magento-Vary=..."
const HEADLESS   = process.env.HEADLESS !== "false";

// --- Login automático (opcional). Se TF_EMAIL/TF_PASSWORD existirem, o serviço
//     loga sozinho e re-loga quando a sessão cair — sem precisar atualizar cookies.
const TF_EMAIL    = process.env.TF_EMAIL || "";
const TF_PASSWORD = process.env.TF_PASSWORD || "";
// Seletores padrão do Magento 2 (sobrescreva por env só se a página for customizada).
const SEL_EMAIL   = process.env.TF_SEL_EMAIL  || '#email, input[name="login[username]"]';
const SEL_PASS    = process.env.TF_SEL_PASS   || '#pass, input[name="login[password]"]';
const SEL_SUBMIT  = process.env.TF_SEL_SUBMIT || '#login-form button.action.login.primary, #login-form button[type="submit"], button.action.login.primary';
const LOGIN_URL   = process.env.TF_LOGIN_URL  || (BASE + "/customer/account/login/");
const ACCOUNT_URL = BASE + "/customer/account/";
const KEEPALIVE_MIN = Number(process.env.KEEPALIVE_MIN || 8);       // re-navega a cada X min p/ manter sessão
const NAV_TIMEOUT   = Number(process.env.NAV_TIMEOUT_MS || 60000);
const USER_AGENT = process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- Estado do navegador ----------------------------------------------
let browser = null;
let context = null;
let page = null;
let warming = null;        // Promise em andamento de warmup (evita corridas)
let lastWarm = 0;

// Converte a string de cookies do navegador em objetos aceitos pelo Playwright.
// Ignora o aws-waf-token: ele é gerado fresco pelo próprio navegador no warmup.
function parseCookies(raw) {
  if (!raw) return [];
  return raw
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const i = c.indexOf("=");
      const name = c.slice(0, i).trim();
      const value = c.slice(i + 1).trim();
      return { name, value };
    })
    .filter((c) => c.name && c.name.toLowerCase() !== "aws-waf-token")
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: ".tizianafausti.net",
      path: "/",
      httpOnly: false,
      secure: true,
    }));
}

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  const cookies = parseCookies(RAW_COOKIES);
  if (cookies.length) await context.addCookies(cookies);
  page = await context.newPage();
}

// Verifica se a sessão está logada (procura o formulário de login na conta).
async function isLoggedIn() {
  await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1500);
  const url = page.url();
  if (/\/customer\/account\/login/i.test(url)) return false;
  const hasLoginField = await page.$(SEL_EMAIL);
  return !hasLoginField; // se não há campo de login visível, está logado
}

// Faz login com e-mail/senha (só roda se TF_EMAIL e TF_PASSWORD estiverem setados).
async function login() {
  if (!TF_EMAIL || !TF_PASSWORD) return false;
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1500);
  // se já redirecionou pra conta, já está logado
  if (!/\/customer\/account\/login/i.test(page.url()) && !(await page.$(SEL_EMAIL))) {
    return true;
  }
  await page.waitForSelector(SEL_EMAIL, { timeout: 15000 });
  await page.fill(SEL_EMAIL, TF_EMAIL);
  await page.fill(SEL_PASS, TF_PASSWORD);
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }).catch(() => {}),
    page.click(SEL_SUBMIT),
  ]);
  await page.waitForTimeout(2500);
  const ok = !/\/customer\/account\/login/i.test(page.url());
  if (!ok) console.error("[tf-search-api] login falhou (verifique credenciais/seletores)");
  else console.log("[tf-search-api] login efetuado com sucesso");
  return ok;
}

// Navega na home para que o AWS WAF rode o challenge.js e emita um token fresco.
// Se houver credenciais e a sessão tiver caído, re-loga automaticamente.
async function warmup() {
  if (warming) return warming;
  warming = (async () => {
    await ensureBrowser();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    // dá tempo do SDK do WAF resolver e setar o aws-waf-token
    await page.waitForTimeout(3000);
    // se temos credenciais, garante a sessão logada
    if (TF_EMAIL && TF_PASSWORD) {
      try {
        if (!(await isLoggedIn())) {
          await login();
        }
        // volta pra home p/ reaquecer o token do WAF após navegar na conta
        await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await page.waitForTimeout(1500);
      } catch (e) {
        console.error("[tf-search-api] erro ao garantir login:", e.message);
      }
    }
    lastWarm = Date.now();
  })();
  try {
    await warming;
  } finally {
    warming = null;
  }
}

const isChallenge = (text) =>
  !text || /awsWaf|challenge\.js|AwsWafIntegration/i.test(text);

// Executa o fetch do autocomplete dentro da página (usa os cookies + token do browser).
async function rawSuggest(q) {
  const url =
    `${BASE}/searchautocomplete/ajax/suggest` +
    `?q=${encodeURIComponent(q)}&store_id=${encodeURIComponent(STORE_ID)}&cat=false`;
  return page.evaluate(async (u) => {
    const r = await fetch(u, {
      method: "GET",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      credentials: "include",
    });
    return { status: r.status, text: await r.text() };
  }, url);
}

// Normaliza um item do JSON da loja num objeto de produto limpo.
function cleanProduct(it) {
  const strip = (s) => (typeof s === "string" ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : s);
  return {
    name: strip(it.name),
    brand: strip(it.manufacturer),
    color: strip(it.color),
    sku: it.sku || null,
    realsku: it.realsku || null,
    codigo_artigo: it.codicearticolo || null,
    price_text: strip(it.price),
    final_price: it.finalprice != null ? Number(it.finalprice) : null,
    last_price: it.lastprice != null ? Number(it.lastprice) : null,
    special_price: it.special_price != null ? Number(it.special_price) : null,
    on_sale: it.is_saldo === "Yes",
    in_stock: it.stock_status === 2 || it.stock_status === "2",
    url: it.url || null,
    image: it.image || null,
  };
}

// Extrai os produtos do JSON completo da resposta.
function extractProducts(json) {
  const idx = (json.indexes || []).find((i) => i.identifier === "magento_catalog_product");
  const items = (idx && idx.items) || [];
  return items.map(cleanProduct);
}

// Busca com 1 retry: se voltar challenge/202, re-aquece o navegador e tenta de novo.
async function search(q) {
  // re-aquece se o warmup ficou velho (mantém sessão + token vivos)
  if (!lastWarm || Date.now() - lastWarm > KEEPALIVE_MIN * 60 * 1000) {
    await warmup();
  }
  let res = await rawSuggest(q);
  if (res.status === 202 || isChallenge(res.text)) {
    await warmup();
    res = await rawSuggest(q);
  }
  if (res.status === 202 || isChallenge(res.text)) {
    const err = new Error("WAF challenge persistente após retry (token/sessão pode ter expirado)");
    err.code = "WAF_CHALLENGE";
    throw err;
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (e) {
    const err = new Error("Resposta não é JSON válido");
    err.code = "BAD_JSON";
    err.sample = res.text.slice(0, 200);
    throw err;
  }
  return {
    query: json.query ?? q,
    total: Number(json.totalItems || 0),
    url_all: json.urlAll || null,
    products: extractProducts(json),
  };
}

// ---------- Fila simples: serializa as buscas (1 página compartilhada) --------
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- HTTP ---------------------------------------------------------------
const app = express();

app.get("/health", (req, res) => {
  res.json({ ok: true, warmedAgoMs: lastWarm ? Date.now() - lastWarm : null });
});

app.get("/search", async (req, res) => {
  if (API_KEY && req.query.key !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "parâmetro 'q' é obrigatório" });

  try {
    const result = await enqueue(() => search(q));
    res.json(result);
  } catch (e) {
    res.status(e.code === "WAF_CHALLENGE" ? 502 : 500).json({
      error: e.message,
      code: e.code || null,
      sample: e.sample || undefined,
    });
  }
});

// keep-alive de fundo: mantém a sessão logada e o token do WAF frescos
if (KEEPALIVE_MIN > 0) {
  setInterval(() => {
    enqueue(() => warmup()).catch(() => {});
  }, KEEPALIVE_MIN * 60 * 1000);
}

app.listen(PORT, async () => {
  console.log(`[tf-search-api] ouvindo na porta ${PORT}`);
  try {
    await enqueue(() => warmup());
    console.log("[tf-search-api] navegador aquecido e pronto");
  } catch (e) {
    console.error("[tf-search-api] falha no warmup inicial:", e.message);
  }
});
