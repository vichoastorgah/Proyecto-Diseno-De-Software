# Guía de despliegue: Render + Supabase

Arquitectura publicada (criterio "Despliegue online e integración" de la rúbrica):

```
Navegador ──► Render: un solo servicio Docker  ──►  Supabase Postgres (datos)
              (React compilado + API Deno/Oak)  ──►  Supabase Storage (bucket privado "attachments")
              https://<servicio>.onrender.com
```

- **Una sola URL pública** sirve la aplicación y la API (`/api/...`): no hay CORS entre dominios y Google SSO
  necesita un único origen autorizado.
- El contenedor **no guarda nada en su disco**: votaciones, votantes, cuestionarios y adjuntos quedan en Supabase.
  En Render la API **se niega a arrancar** si falta la base de datos o el almacenamiento de Supabase (así nunca se
  pierden datos en un reinicio).
- El navegador **nunca** recibe claves de Supabase. Las tablas tienen **Row Level Security activado sin políticas**:
  la API REST pública de Supabase no puede leerlas.
- Producción parte con la base vacía: los datos locales (JSON antiguos, base local) **no se suben**.
- `Dockerfile`: compila React con `node:22.23.3-alpine` y ejecuta la API con `denoland/deno:2.9.7` como usuario sin
  privilegios. `.dockerignore` deja fuera `.env`, CSV, bases locales y datos.
- `render.yaml`: la misma configuración como *Blueprint* (infraestructura como código).

Probado localmente con Docker antes de publicar: PostgreSQL 17 real, reinicio del contenedor sin pérdida de datos,
10 votos simultáneos con el mismo enlace (se acepta 1) y votación completa en un navegador de celular.

---

## 1. Supabase (ya creado)

1. **Cambia la contraseña de la base de datos** si alguna vez quedó a la vista (chat, capturas, logs):
   **Project Settings → Database → Reset database password**. Usa una sin símbolos (`@ # / ? %`) para evitar
   problemas en la URL.
2. **Cadena de conexión (`DATABASE_URL`)**: botón **Connect** (arriba) → **Session pooler** → copia la URI
   **completa**. Reemplaza `[YOUR-PASSWORD]` (incluidos los corchetes) por tu contraseña y agrega
   `?sslmode=require` al final. Debe verse así (todo en una línea):
   ```
   postgresql://postgres.<ref>:<password>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   Si solo pegas la contraseña o falta `postgresql://`, la API se detiene con
   `DATABASE_URL is invalid (...)` en los *Logs* (sin mostrar el valor).
3. **Storage**: bucket `attachments`, **privado**.
4. **Claves**: **Project Settings → API Keys** → una **secret key** (`sb_secret_…`) → `SUPABASE_SERVICE_ROLE_KEY`.
   `SUPABASE_URL` es `https://<ref>.supabase.co`.

## 2. Render (aplicación completa)

Puedes **reutilizar el Web Service que ya creaste** (opción A) o crear uno nuevo desde el Blueprint (opción B).

### Opción A: el servicio existente

1. En Render → tu servicio → **Settings**: *Branch* `main`, *Runtime* Docker, *Health Check Path* `/api/health`.
2. **Environment** → deja exactamente estas variables (Render define `PORT`, `RENDER` y `RENDER_EXTERNAL_URL` solo;
   **no** agregues `ALLOWED_ORIGIN`, `APP_BASE_URL` ni `VOTE_BASE_URL`, se calculan con la URL pública):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la URI completa del paso 1.2 |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` |
   | `SUPABASE_BUCKET` | `attachments` |
   | `GOOGLE_CLIENT_ID` | el mismo de tu `.env` local |
   | `ADMIN_EMAILS` | tu correo de Google (separa varios con comas) |
   | `SESSION_SECRET` | 64 caracteres aleatorios: `deno eval "console.log(crypto.randomUUID()+crypto.randomUUID())"` |
   | `DEFAULT_EMAIL_LANGUAGE` | `es` |
   | `ALLOW_DEMO_SURVEY_IDENTITY` | `true` (permite "Actuar como" en la demo de cuestionarios) |

3. **Save, rebuild, and deploy** (o *Manual Deploy → Deploy latest commit*).

### Opción B: Blueprint

**New → Blueprint** → elegir el repositorio → Render lee `render.yaml`, pide los valores marcados como secretos y
genera `SESSION_SECRET`. (Si usas esta opción, elimina el servicio antiguo para no tener dos.)

### Comprobar

- **Logs**: deben aparecer `[db] Driver: postgres. [files] Store: supabase.` y `Server listening…`.
- `https://<servicio>.onrender.com/api/health` → `{"status":"ok"}`.
- Plan gratuito: el servicio se **suspende tras 15 minutos sin uso** y la siguiente visita tarda ~30–60 s.
  Antes de una demo abre la URL una vez para "despertarlo".

## 3. Google Cloud (SSO)

**APIs & Services → Credentials → tu OAuth client (Web) → Authorized JavaScript origins** → agrega
`https://<servicio>.onrender.com` (sin `/` final; mantén `http://localhost:5173` para desarrollo). Puede tardar
unos minutos en aplicarse.

## 4. Correos en producción

- Sin `SMTP_USER`/`SMTP_PASS` los correos se **simulan**: el mensaje completo (con el enlace de votación) aparece en
  los *Logs* de Render. Sirve para la demo.
- Para envío real: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (Gmail con *contraseña de
  aplicación*). **Pendiente de verificar**: el plan gratuito de Render puede bloquear puertos SMTP salientes; si los
  envíos quedan como "Falló el envío", se necesitaría un servicio de correo por HTTP (cambio acotado en
  `server/services/emailService.ts`).

## 5. Lista de verificación en producción (desde otro dispositivo)

1. Abrir `https://<servicio>.onrender.com` en el celular → página de inicio de sesión con el botón de Google.
2. Iniciar sesión con la cuenta de `ADMIN_EMAILS` → panel de administración.
3. Crear una votación con `samples/voters.example.csv` y un PDF → el archivo aparece en el bucket `attachments`.
4. Copiar un enlace de votación desde los *Logs* de Render, abrirlo en otro dispositivo, votar, recargar → "Ya votaste".
5. Cerrar la votación → resultados ponderados con "Integridad verificada".
6. Crear un cuestionario, delegar y responder ("Actuar como").
7. **Render → Manual Deploy → Restart service** y comprobar que todo sigue ahí (persistencia).
8. Cambiar ES/EN.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `DATABASE_URL is invalid (...)` en los Logs | No es la URI completa (falta `postgresql://`, usuario, host o contraseña) o quedó `[YOUR-PASSWORD]` |
| `[config] The server cannot start safely…` | Falta alguna de las variables listadas en ese mensaje |
| Error de conexión/contraseña al arrancar | Contraseña cambiada en Supabase pero no en `DATABASE_URL`, o símbolos sin codificar |
| Google muestra "origin is not allowed" | Falta `https://<servicio>.onrender.com` en *Authorized JavaScript origins* |
| `403 UNAUTHORIZED_USER` al entrar | Tu correo no está en `ADMIN_EMAILS` |
| Error al crear una votación con adjunto | `SUPABASE_SERVICE_ROLE_KEY` incorrecta o el bucket `attachments` no existe |
| La primera carga tarda casi un minuto | El plan gratuito estaba suspendido; es normal |
