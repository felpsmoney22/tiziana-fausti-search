# TF Search API — busca na Tiziana Fausti para o n8n

Micro-serviço que resolve a proteção **AWS WAF** da Tiziana Fausti usando um
navegador real (Chromium via Playwright) e mantém a sua **sessão logada**.
O n8n passa a chamar este serviço com um **HTTP Request simples** e recebe os
produtos já parseados em JSON — sem cookie de WAF, sem headers manuais, sem
token que expira.

- **100% livre e open-source** (Playwright é Apache 2.0). Sem taxa por request.
- **Self-hosted no Railway**, do lado do seu n8n.
- **Mantém o login** (`PHPSESSID`) e resolve o WAF sozinho a cada renovação.

---

## Por que isto é necessário

O endpoint `searchautocomplete/ajax/suggest` fica atrás do AWS WAF. Ele exige um
cookie `aws-waf-token` que **só é gerado rodando um JavaScript de desafio** — algo
que um HTTP Request node puro do n8n não consegue fazer. Por isso a sua chamada
antiga voltava aquela página de "challenge" em vez dos produtos.

Este serviço roda um Chromium de verdade: ao navegar no site, o WAF resolve o
desafio e emite o token automaticamente. Aí o serviço executa a busca **dentro
da página** (mesmos cookies, mesmo fingerprint de um navegador real) e devolve o
JSON limpo.

---

## 1) Deploy no Railway

Você tem duas formas. A mais direta é subir estes arquivos como um repositório e
apontar o Railway pra ele.

1. Crie um repositório no GitHub com estes 4 arquivos: `server.js`, `package.json`,
   `Dockerfile`, `README.md`.
2. No Railway: **New Project → Deploy from GitHub repo** → selecione o repo.
3. O Railway detecta o `Dockerfile` e faz o build sozinho (Chromium já vem na imagem).
4. Em **Settings → Networking**, gere um domínio público (ex.: `tf-search-api-production.up.railway.app`).

> Alternativa sem GitHub: instale a Railway CLI, rode `railway init` nesta pasta
> e depois `railway up`.

### Variáveis de ambiente (aba **Variables** no Railway)

| Variável        | Obrigatória | Exemplo / descrição                                                                 |
|-----------------|-------------|-------------------------------------------------------------------------------------|
| `API_KEY`       | recomendada | Uma senha aleatória sua (ex.: `troque-isto-123`). Protege o endpoint.               |
| `TF_EMAIL`      | ver abaixo  | E-mail da sua conta na Tiziana Fausti (para login automático).                       |
| `TF_PASSWORD`   | ver abaixo  | Senha da sua conta (para login automático).                                         |
| `TF_COOKIES`    | ver abaixo  | Cookies de login do navegador. Ex.: `PHPSESSID=...; X-Magento-Vary=...`             |
| `TF_STORE_ID`   | não         | Padrão `2`.                                                                          |
| `TF_BASE`       | não         | Padrão `https://www.tizianafausti.net/vip1_en`.                                     |
| `KEEPALIVE_MIN` | não         | Padrão `8`. De quantos em quantos minutos o serviço re-aquece a sessão/token.       |
| `USER_AGENT`    | não         | User-Agent do Chrome (já tem um padrão sensato).                                     |

### Como manter a sessão logada — escolha UM dos dois modos

**Modo A — Login automático (recomendado, 100% autônomo):** defina `TF_EMAIL` e
`TF_PASSWORD`. O serviço loga sozinho no arranque e **re-loga automaticamente**
sempre que a sessão cair. Nesse modo o `TF_COOKIES` não é necessário. Você nunca
mais precisa mexer em cookie.

**Modo B — Cookies manuais:** deixe `TF_EMAIL`/`TF_PASSWORD` vazios e informe
`TF_COOKIES`. Mais simples, mas quando a sessão expirar você tem que atualizar a
variável com cookies novos.

> **Seletores de login:** o serviço usa os campos padrão do Magento 2
> (`#email`, `#pass`, `button.action.login.primary`). Se por acaso a página de
> login da loja for customizada e o login não funcionar, dá pra sobrescrever sem
> mexer no código, via as variáveis opcionais `TF_SEL_EMAIL`, `TF_SEL_PASS`,
> `TF_SEL_SUBMIT` e `TF_LOGIN_URL`.

> **Memória:** deixe o serviço com **~1 GB de RAM** no Railway. Chromium é pesado.

### O que colocar em `TF_COOKIES`

Só os cookies de **sessão/login** — o `aws-waf-token` **não** precisa ir (o serviço
gera um fresco sozinho). O mínimo é:

```
PHPSESSID=SEU_VALOR; X-Magento-Vary=SEU_VALOR
```

Como pegar (uma vez): no Chrome logado no site → F12 → aba **Application** →
**Cookies** → `https://www.tizianafausti.net` → copie os valores de `PHPSESSID` e
`X-Magento-Vary`.

> A sessão do Magento se mantém viva enquanto o serviço fica ativo (o keep-alive
> re-navega a cada poucos minutos). Se um dia as buscas começarem a voltar vazias
> ou com erro de WAF, é sinal de que a sessão expirou de vez: gere cookies novos e
> atualize a variável `TF_COOKIES`. (Se quiser, dá pra evoluir pra login automático
> com e-mail/senha — veja o final.)

---

## 2) Testar o serviço

Depois do deploy, teste no navegador ou no terminal:

```
https://SEU-SERVICO.up.railway.app/health
```

Deve responder `{"ok":true,...}`. Então teste uma busca:

```
https://SEU-SERVICO.up.railway.app/search?q=Saint%20Laurent%20Paris%20Mini&key=SUA_API_KEY
```

Resposta esperada (JSON já parseado):

```json
{
  "query": "Saint Laurent Paris Mini",
  "total": 1,
  "url_all": "https://www.tizianafausti.net/vip1_en/catalogsearch/result/?",
  "products": [
    {
      "name": "Saint Laurent Paris mini shoulder bag in smooth leather",
      "brand": "SAINT LAURENT",
      "color": "Black",
      "sku": "8197582ZA0W1000",
      "realsku": "149506661_UNI",
      "codigo_artigo": "8197582ZA0W1000",
      "price_text": "€960.00 - 10% €1,066.00",
      "final_price": 960,
      "last_price": 1066,
      "special_price": 960,
      "on_sale": true,
      "in_stock": true,
      "url": "https://www.tizianafausti.net/vip1_en/woman-...",
      "image": "https://www.tizianafausti.net/media/catalog/product/..."
    }
  ]
}
```

---

## 3) Ajustar o fluxo no n8n

No lugar do seu HTTP Request node atual (aquele com URL da Tiziana + cookie do WAF
+ headers), configure assim:

- **Method:** `GET`
- **URL:** `https://SEU-SERVICO.up.railway.app/search`
- **Query Parameters:**
  - `q` = `{{ $('Split Out3').item.json.query }}`  ← a mesma expressão que você já usa
  - `key` = `SUA_API_KEY`
- **Headers:** nenhum. Pode remover `X-Requested-With` e o `Cookie` gigante.
- **Send Query Parameters:** ligado.

Pronto. Cada item do seu Split continua funcionando igual; a diferença é que a
resposta já vem como `{{ $json.products }}` — uma lista limpa de produtos.

> Dica: se quiser 1 produto por linha no n8n, adicione um **Split Out** no campo
> `products` depois deste node.

---

## Notas de operação

- **Concorrência:** o serviço serializa as buscas (uma página de navegador
  compartilhada). Para o volume de um fluxo de busca de produtos isso é de sobra.
  Se um dia precisar de mais paralelismo, dá pra criar um pool de páginas.
- **Custo:** só o do container no Railway. Nenhuma API paga, nenhum solver.
- **Robustez:** se uma busca cair num challenge (token velho), o serviço re-aquece
  o navegador automaticamente e tenta de novo uma vez antes de retornar erro.

## Login automático (já incluído)

O serviço já faz login sozinho quando você define `TF_EMAIL` e `TF_PASSWORD`
(Modo A acima). Ele detecta quando a sessão caiu e re-loga automaticamente, então
não é preciso atualizar cookies manualmente. As credenciais ficam só como
variáveis de ambiente na sua própria infra (Railway) — não vão pro código nem
saem do seu ambiente.

Ele usa os seletores padrão do Magento 2. Se a loja tiver uma página de login
customizada e o login não funcionar de primeira, sobrescreva os seletores pelas
variáveis `TF_SEL_EMAIL`, `TF_SEL_PASS`, `TF_SEL_SUBMIT` (opcionais) — sem tocar
no código.
