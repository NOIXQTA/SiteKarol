# Sistema de Agendamento com Cliente e Administrador

Este projeto agora tem duas camadas:

- `index.html`: site publico de apresentacao do studio
- `portal.html`: area segura para login, reservas e administracao
- `server.py`: backend com autenticacao, agenda, banco SQLite e preparacao para WhatsApp

## O que foi implementado

- autenticacao com senha protegida por hash
- dois perfis: `client` e `admin`
- cadastro e login para clientes
- painel administrativo separado
- criacao, edicao e exclusao de creneaux
- reserva com bloqueio automatico do horario confirmado
- cancelamento e reprogramacao de rendez-vous
- persistencia em SQLite em `data/booking.db`
- preparacao para envio de confirmacao via WhatsApp com Meta Cloud API

## Como iniciar

No PowerShell:

```powershell
.\start_server.ps1
```

Depois abra:

- `http://127.0.0.1:8000/`
- `http://127.0.0.1:8000/portal.html`

## Login administrador inicial

Na primeira execucao, o backend cria um admin padrao:

- email: `admin@studio.local`
- senha: `Admin123!`

Antes de publicar, o ideal e trocar essas credenciais. Tambem e possivel definir antes da primeira execucao:

- `BOOKING_ADMIN_EMAIL`
- `BOOKING_ADMIN_PASSWORD`
- `BOOKING_ADMIN_NAME`

## WhatsApp

### Opcao recomendada para vender ao cliente: Meta Cloud API

Esta e a opcao oficial da Meta e fica como prioridade automatica no backend quando configurada.

Configure:

- `META_WHATSAPP_TOKEN`
- `META_WHATSAPP_PHONE_NUMBER_ID`

Opcional:

- `META_WHATSAPP_API_VERSION`
- `META_WHATSAPP_TEMPLATE_NAME`
- `META_WHATSAPP_TEMPLATE_LANG`

Se `META_WHATSAPP_TEMPLATE_NAME` for informado, o sistema envia a confirmacao com template aprovado da Meta.
Se nao for informado, ele tenta enviar mensagem de texto simples.

### Alternativa: Twilio

O sistema continua com compatibilidade com Twilio. Para ativar esse envio, configure:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`

Sem configuracao Meta ou Twilio, o agendamento funciona normalmente e o status da notificacao fica como `skipped`.

## Observacoes

- o banco e criado automaticamente em `data/booking.db`
- o portal usa autenticacao por cookie de sessao
- o sistema impede dois agendamentos confirmados no mesmo horario
