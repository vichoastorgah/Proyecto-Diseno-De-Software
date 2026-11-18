# Guía de despliegue: Vercel + Supabase + Deno Deploy

Arquitectura publicada (criterio "Despliegue online e integración" de la rúbrica):

```
Navegador ──► Vercel (frontend React, estático)
                 │  VITE_API_BASE_URL
                 ▼
            Deno Deploy (API Deno + Oak, sin estado)
                 │  DATABASE_URL            │  SUPABASE_URL + SERVICE_ROLE_KEY
                 ▼                          ▼
        Supabase Postgres            Supabase Storage (bucket privado "attachments")
```

- El frontend **nunca** recibe claves de Supabase: solo habla con la API.
- Las tablas tienen **Row Level Security activado sin políticas**: la API REST pública de Supabase no puede
  leerlas aunque alguien conozca la URL del proyecto y la clave `anon`. La API se conecta como dueña de las tablas.
- Producción parte con la base de datos vacía: los datos locales (JSON antiguos, base local) **no se suben**.

Tiempo estimado: 45–60 minutos. Todos los servicios tienen plan gratuito.

---

## 1. Supabase (base de datos y archivos)

1. Crear una cuenta en <https://supabase.com> y un proyecto nuevo.
   - Región sugerida: **South America (São Paulo)**.
   - Guarda la contraseña de la base de datos en un lugar seguro.
2. **Cadena de conexión:** botón **Connect** → pestaña de conexión → **Session pooler** (compatible con IPv4).
   Copia la URI y reemplaza `[YOUR-PASSWORD]`. Agrega `?sslmode=require` al final:
   ```
   postgresql://postgres.<ref>:<password>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   Este valor es `DATABASE_URL`. (El *transaction pooler*, puerto 6543, también funciona: la API desactiva los
   *prepared statements*.)
3. **Storage:** menú **Storage** → **New bucket** → nombre `attachments` → **dejarlo privado** (Public desactivado).
4. **Claves:** **Project Settings → API**:
   - `Project URL` → `SUPABASE_URL`.
   - Clave **`service_role`** (en "Legacy API keys", o la clave *secret* nueva) → `SUPABASE_SERVICE_ROLE_KEY`.
     Es secreta: solo va en el servidor (Deno Deploy), nunca en Vercel ni en el repositorio.
5. No hay que crear tablas a mano: la API aplica las migraciones al arrancar (tabla `schema_migrations`).

## 2. Deno Deploy (API)

1. Entrar a <https://deno.com/deploy> con GitHub y crear un proyecto desde el repositorio.
2. Rama: `feature/professional-upgrade` (o `main` cuando se fusione). Punto de entrada: **`server/server.ts`**.
   No necesita paso de *build*; usa `deno.json` (mapa de imports).
3. Variables de entorno del proyecto:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | URI del paso 1.2 |
   | `SUPABASE_URL` | URL del proyecto |
   | `SUPABASE_SERVICE_ROLE_KEY` | clave `service_role` |
   | `SUPABASE_BUCKET` | `attachments` |
   | `GOOGLE_CLIENT_ID` | el mismo del frontend |
   | `SESSION_SECRET` | 64 caracteres aleatorios: `deno eval "console.log(crypto.randomUUID()+crypto.randomUUID())"` |
   | `ADMIN_EMAILS` | tu correo de Google (administrador) |
   | `ALLOWED_ORIGIN` | `https://<tu-app>.vercel.app` |
   | `APP_BASE_URL` | `https://<tu-app>.vercel.app` |
   | `VOTE_BASE_URL` | `https://<tu-app>.vercel.app/vote` |
   | `DEFAULT_EMAIL_LANGUAGE` | `es` |
   | `ALLOW_DEMO_SURVEY_IDENTITY` | `true` solo si quieres usar "Actuar como" en la demo |

4. Comprobar: `https://<tu-api>.deno.dev/api/health` debe responder `{"status":"ok"}`. En los *logs* debe aparecer
   `[db] Driver: postgres. [files] Store: supabase.`

## 3. Vercel (frontend)

1. Entrar a <https://vercel.com> con GitHub → **Add New Project** → importar el repositorio.
2. **Root Directory:** `client`. Framework: **Vite** (build `npm run build`, salida `dist`).
3. Variables de entorno:

   | Variable | Valor |
   |---|---|
   | `VITE_API_BASE_URL` | `https://<tu-api>.deno.dev` (sin `/` final) |
   | `VITE_GOOGLE_CLIENT_ID` | el client id de Google |

4. `client/vercel.json` ya redirige todas las rutas a `index.html`, para que funcionen enlaces como `/vote?token=…`.
5. Si cambias variables, vuelve a desplegar (Vite las inserta al compilar).

## 4. Google Cloud (SSO)

En **APIs & Services → Credentials → tu OAuth client (Web)** agrega en *Authorized JavaScript origins*:
`https://<tu-app>.vercel.app` (además de `http://localhost:5173` para desarrollo).

## 5. Correos en producción

- Sin `SMTP_USER`/`SMTP_PASS` los correos se **simulan**: el mensaje completo (con el enlace de votación) aparece
  en los *logs* de Deno Deploy. Sirve para la demo.
- Para envío real se pueden configurar `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
  (Gmail con *contraseña de aplicación*). **Pendiente de verificar en Deno Deploy:** si la plataforma bloquea las
  conexiones SMTP salientes, los envíos quedarán como "Falló el envío" y habría que usar un servicio de correo por
  HTTP (requiere un cambio de código acotado en `server/services/emailService.ts`).

## 6. Lista de verificación en producción

1. `/api/health` responde `ok`.
2. Iniciar sesión con Google en la URL de Vercel → llegas al panel como administrador.
3. Crear una votación con `samples/voters.example.csv` y un PDF → el adjunto aparece en el bucket `attachments`.
4. Abrir un enlace de votación (desde los *logs* o el correo), votar, recargar → "Ya votaste".
5. Cerrar la votación → resultados ponderados con "Integridad verificada".
6. Crear un cuestionario, delegar y responder.
7. En Supabase → **Table Editor** comprobar que las tablas existen y que la tabla `ballots` no tiene datos de votantes.
8. Cambiar ES/EN y revisar en el celular.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| El navegador muestra "No se pudo conectar con el servidor" | `VITE_API_BASE_URL` incorrecta, o `ALLOWED_ORIGIN` no coincide exactamente con la URL de Vercel |
| `403 UNAUTHORIZED_USER` al entrar | Tu correo no está en `ADMIN_EMAILS` |
| Google muestra "origin is not allowed" | Falta la URL de Vercel en *Authorized JavaScript origins* |
| Error 500 al crear una votación con adjunto | Falta `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` o el bucket no existe |
| La API no arranca: error de conexión | `DATABASE_URL` mal copiada (contraseña) o falta `?sslmode=require` |
