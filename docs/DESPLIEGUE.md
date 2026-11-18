# Guía de despliegue: Vercel + Supabase + Render

Arquitectura publicada (criterio "Despliegue online e integración" de la rúbrica):

```
Navegador ──► Vercel (frontend React, estático)
                 │  VITE_API_BASE_URL
                 ▼
            Render (contenedor Docker con la API Deno + Oak, sin estado)
                 │  DATABASE_URL            │  SUPABASE_URL + clave secreta
                 ▼                          ▼
        Supabase Postgres            Supabase Storage (bucket privado "attachments")
```

- El frontend **nunca** recibe claves de Supabase: solo habla con la API.
- Las tablas tienen **Row Level Security activado sin políticas**: la API REST pública de Supabase no puede
  leerlas aunque alguien conozca la URL del proyecto y la clave pública. La API se conecta como dueña de las tablas.
- Producción parte con la base de datos vacía: los datos locales (JSON antiguos, base local) **no se suben**.

Tiempo estimado: 45–60 minutos. Todos los servicios tienen plan gratuito.

---

## 0. ¿Qué rama se publica?

Render y Vercel publican la rama **`main`** (ya fusionada). Cada *push* a `main` vuelve a desplegar ambos.

## 1. Supabase (base de datos y archivos)

1. Crear una cuenta en <https://supabase.com> y un proyecto nuevo.
   - Región sugerida: **South America (São Paulo)**.
   - Guarda la contraseña de la base de datos en un lugar seguro.
2. **Cadena de conexión:** botón **Connect** (arriba) → **Session pooler** (compatible con IPv4).
   Copia la URI, reemplaza `[YOUR-PASSWORD]` y agrega `?sslmode=require` al final:
   ```
   postgresql://postgres.<ref>:<password>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   Este valor es `DATABASE_URL`. (El *transaction pooler*, puerto 6543, también funciona: la API desactiva los
   *prepared statements*.) Si la contraseña tiene símbolos como `@`, `#` o `/`, cámbiala por una sin símbolos o
   codifícalos en la URL.
3. **Storage:** menú **Storage** → **New bucket** → nombre `attachments` → **Public bucket desactivado**.
4. **Claves:** **Project Settings → API Keys**:
   - `Project URL` (en *Data API* o en el botón *Connect*) → `SUPABASE_URL`, por ejemplo `https://abcd.supabase.co`.
   - Una **secret key** (`sb_secret_…`; si no hay, crea una con *Create new secret key*) → `SUPABASE_SERVICE_ROLE_KEY`.
     La API también acepta la clave antigua `service_role` (JWT), que Supabase dejará de ofrecer a fines de 2026.
     Es secreta: solo va en Render, nunca en Vercel, en el chat ni en el repositorio.
5. No hay que crear tablas a mano: la API aplica las migraciones al arrancar (tabla `schema_migrations`).

## 2. Render (API)

> Deno Deploy dejó de aceptar cuentas nuevas (cierra en abril de 2027), por eso la API se publica como contenedor.
> El `Dockerfile` de la raíz usa la imagen oficial `denoland/deno:2.9.7`, instala las dependencias, corre con un
> usuario sin privilegios y no incluye `client/`, `.env`, CSV ni datos locales (`.dockerignore`). Se probó localmente
> con Docker, con el puerto inyectado y conectado a Postgres por red.

1. Entrar a <https://render.com> → **Get Started** → iniciar sesión con **GitHub**.
2. **+ New → Web Service** → conectar el repositorio `Proyecto-Diseno-De-Software` (si no aparece, *Configure account*
   y dar acceso al repositorio).
3. Configuración:
   - **Branch:** `main` · **Language/Runtime:** `Docker` (lo detecta por el `Dockerfile`) · **Root Directory:** vacío.
   - **Region:** `Virginia (US East)` (la más cercana a Supabase São Paulo).
   - **Instance Type:** `Free`.
   - **Advanced → Health Check Path:** `/api/health`.
4. **Environment Variables** (Render define `PORT` solo; no lo agregues):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | URI del paso 1.2 (Session pooler, con `?sslmode=require`) |
   | `SUPABASE_URL` | URL del proyecto |
   | `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` |
   | `SUPABASE_BUCKET` | `attachments` |
   | `SESSION_SECRET` | genera uno en tu terminal: `deno eval "console.log(crypto.randomUUID()+crypto.randomUUID())"` |
   | `GOOGLE_CLIENT_ID` | el mismo del frontend |
   | `ADMIN_EMAILS` | tu correo de Google (administrador) |
   | `DEFAULT_EMAIL_LANGUAGE` | `es` |
   | `ALLOW_DEMO_SURVEY_IDENTITY` | `true` solo si quieres usar "Actuar como" en la demo |
   | `ALLOWED_ORIGIN`, `APP_BASE_URL` | URL de Vercel, ej. `https://<proyecto>.vercel.app` (se completan en el paso 3) |
   | `VOTE_BASE_URL` | URL de Vercel + `/vote` (paso 3) |

5. **Create Web Service**. La primera compilación tarda unos minutos. La URL queda como `https://<nombre>.onrender.com`.
6. Comprobar `https://<nombre>.onrender.com/api/health` → `{"status":"ok"}`. En **Logs** debe aparecer
   `[db] Driver: postgres. [files] Store: supabase.`
7. Plan gratuito: el servicio se **suspende tras 15 minutos sin uso** y la primera petición siguiente tarda ~30–60 s.
   Antes de una demo abre `/api/health` una vez para "despertarlo".
8. Si cambias variables, Render vuelve a desplegar automáticamente (o usa *Manual Deploy → Deploy latest commit*).

## 3. Vercel (frontend)

1. Entrar a <https://vercel.com> con GitHub → **Add New… → Project** → importar el repositorio.
2. **Root Directory:** `client`. Framework: **Vite** (build `npm run build`, salida `dist`).
3. Variables de entorno:

   | Variable | Valor |
   |---|---|
   | `VITE_API_BASE_URL` | `https://<nombre>.onrender.com` (sin `/` final) |
   | `VITE_GOOGLE_CLIENT_ID` | el client id de Google |

4. **Deploy**. Copia la URL de producción (`https://<proyecto>.vercel.app`) y complétala en Render
   (`ALLOWED_ORIGIN`, `APP_BASE_URL`, `VOTE_BASE_URL`); Render redespliega solo.
5. `client/vercel.json` ya redirige todas las rutas a `index.html`, para que funcionen enlaces como `/vote?token=…`.
6. Si cambias variables de Vercel, vuelve a desplegar (Vite las inserta al compilar).

## 4. Google Cloud (SSO)

En **APIs & Services → Credentials → tu OAuth client (Web)** agrega en *Authorized JavaScript origins*:
`https://<proyecto>.vercel.app` (además de `http://localhost:5173` para desarrollo). El cambio puede tardar unos minutos.

## 5. Correos en producción

- Sin `SMTP_USER`/`SMTP_PASS` los correos se **simulan**: el mensaje completo (con el enlace de votación) aparece
  en los *logs* de Render. Sirve para la demo.
- Para envío real se pueden configurar `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
  (Gmail con *contraseña de aplicación*). **Pendiente de verificar en Render:** los planes gratuitos de algunos
  proveedores bloquean los puertos SMTP salientes. Si no, los envíos quedarán como "Falló el envío" y habría que usar un servicio
  de correo por HTTP (cambio acotado en `server/services/emailService.ts`).

## 6. Lista de verificación en producción

1. `/api/health` responde `ok`.
2. Iniciar sesión con Google en la URL de Vercel → llegas al panel como administrador.
3. Crear una votación con `samples/voters.example.csv` y un PDF → el adjunto aparece en el bucket `attachments`.
4. Abrir un enlace de votación (desde los *logs* o el correo), votar, recargar → "Ya votaste".
5. Abrir el mismo enlace en dos pestañas y votar casi a la vez → solo una cuenta.
6. Cerrar la votación → resultados ponderados con "Integridad verificada".
7. Crear un cuestionario, delegar y responder.
8. En Supabase → **Table Editor**: las tablas existen y `ballots` no tiene datos de votantes.
9. Cambiar ES/EN y revisar en el celular.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| "No se pudo conectar con el servidor" | `VITE_API_BASE_URL` incorrecta, o `ALLOWED_ORIGIN` no coincide exactamente con la URL de Vercel |
| `403 UNAUTHORIZED_USER` al entrar | Tu correo no está en `ADMIN_EMAILS` |
| Google muestra "origin is not allowed" | Falta la URL de Vercel en *Authorized JavaScript origins* |
| Error 500 al crear una votación con adjunto | Falta `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` o el bucket no existe |
| La API responde 502 o no arranca | Revisa los *Logs* de Render: `DATABASE_URL` mal copiada (contraseña) o falta `?sslmode=require` |
| La primera carga tarda casi un minuto | El plan gratuito de Render estaba suspendido; es normal |
| Las sesiones se cierran al reiniciar la API | `SESSION_SECRET` vacío, corto o con el texto de ejemplo |
