# Saúde diária

App (PWA) para marcar remédios, registrar glicose e pressão, ver o histórico e fazer backup.
Funciona sem internet e sincroniza celular e computador pelo Supabase.

## 1. Criar o projeto no Supabase
1. Acesse **supabase.com** → **Start your project** → entre com o GitHub.
2. **New project** → dê um nome, crie uma senha do banco (guarde) → região **South America (São Paulo)** → **Create**.

## 2. Rodar o schema.sql
1. No menu lateral, abra **SQL Editor** → **New query**.
2. Abra o arquivo `supabase/schema.sql` deste repositório no GitHub → botão **Raw** → copie tudo.
3. Cole no editor e toque em **Run**. Deve aparecer "Success. No rows returned".

## 3. Criar o usuário do seu pai
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Preencha e-mail e senha e marque **Auto Confirm User**.
3. Em **Authentication** → **Sign In / Providers** → **Email**, desligue **Allow new users to sign up** (ninguém mais cria conta).

## 4. Pegar a URL e a chave anon
**Project Settings** (engrenagem) → **API Keys** (ou o botão **Connect** no topo):
- **Project URL**: `https://xxxx.supabase.co`
- **anon public** (ou **publishable**, começa com `sb_publishable_`).

Nunca use a chave **service_role** / **secret**.

## 5. Colocar no config.js
No GitHub, abra `config.js` → ícone de lápis → troque os dois valores → **Commit changes**:
```js
window.SUPABASE_URL = 'https://xxxx.supabase.co';
window.SUPABASE_ANON_KEY = 'sua-chave-anon';
```
A chave anon pode ficar pública: quem protege os dados é o login + Row Level Security.

## 6. Ativar o GitHub Pages
Repositório → **Settings** → **Pages** → Source: **Deploy from a branch** → Branch **main**, pasta **/ (root)** → **Save**.
Em 1–2 minutos o endereço aparece no topo da página: `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

## 7. Instalar o app
- **Android (Chrome):** abra o endereço → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPhone (Safari):** abra o endereço no **Safari** → botão Compartilhar → **Adicionar à Tela de Início**.
- **Desktop (Chrome/Edge):** abra o endereço → ícone de instalar na barra de endereço → **Instalar**.

Abra o app instalado, faça login uma vez e pronto: a sessão fica salva.
No primeiro login com a conta vazia, o app cria a lista de remédios padrão.

## Trazer os dados do protótipo antigo
O app só encontra os dados antigos sozinho se o protótipo era aberto **no mesmo endereço** (mesmo site do GitHub Pages, no mesmo navegador).
Se o protótipo rodava em outro lugar (ex.: claude.ai ou um arquivo aberto no celular):
1. No protótipo antigo: **Dados → Baixar backup (.json)**.
2. No app novo: **Dados → Juntar dados de um backup** → escolha o arquivo. O que faltar é acrescentado, nada é apagado, e os dados vão para todos os aparelhos.

## Atualizar o app
Depois de mudar qualquer arquivo, aumente a versão em `sw.js` (`saude-v1` → `saude-v2`) para os aparelhos baixarem a nova versão.

## Testes
`node tests/sync.test.mjs`
