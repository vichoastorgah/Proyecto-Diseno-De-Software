# Guía de estudio para la demo y la defensa técnica

Objetivo: poder explicar **cómo funciona** el sistema, **por qué** se diseñó así y **qué pasa en los casos borde**.
La rúbrica evalúa individualmente "comprensión y casos borde" (3 pts) y "preguntas técnicas" (3 pts).

---

## 1. La arquitectura en 30 segundos

- **Frontend:** React 19 + Vite + Bootstrap 5 (`client/`). Una SPA que solo muestra datos y llama a la API.
  Nunca decide permisos: las reglas viven en el servidor.
- **Backend:** Deno 2 + Oak 17 en TypeScript (`server/`). Capas:
  `http/` (lee la petición y revisa el rol) → `services/` (reglas de negocio) → `db/` (SQLite).
- **Base de datos:** SQLite con el módulo `node:sqlite` que ya trae Deno (sin dependencias). Tablas relacionadas
  con claves foráneas y restricciones `CHECK`/`UNIQUE`.
- **Autenticación:** Google SSO. El navegador obtiene un *ID token* de Google, el servidor lo verifica con las
  claves públicas de Google y entrega su propia sesión firmada (JWT de 8 h).
- **Errores:** todos los servicios lanzan `AppError(status, code, message, details)`. El cliente traduce el `code`.

Archivo de entrada: `server/server.ts` → `createApp()` en `server/app.ts`.

---

## 2. Flujos principales (con archivos)

### Crear una votación
1. `ElectionCreateView.jsx`: título, descripción, mociones con opciones, CSV y adjuntos.
2. Al elegir el CSV se llama a `POST /api/admin/csv/validate` → `csvService.parseVotersCsv`:
   se ven los errores por fila **antes** de enviar.
3. `POST /api/admin/elections` (`http/adminRoutes.ts`):
   - valida los metadatos (`validateElectionMetadata`), el CSV y los adjuntos (`prepareAttachments`);
   - `createElection` guarda **todo en una sola transacción** (votación, mociones, opciones, adjuntos, votantes);
   - cada votante recibe un token aleatorio de 256 bits; en la base de datos solo se guarda su **hash SHA-256**;
   - `sendInvitations` envía un correo por votante (personalizado con nombre y género, con adjuntos) y registra si se envió.

### Votar
1. El votante abre `/vote?token=…` (`VotingView.jsx`) → `GET /api/vote/context` devuelve las mociones y sus opciones.
2. Elige una opción por moción, revisa y confirma → `POST /api/vote` con `{ token, choices }`.
3. `votingService.castBallot`, dentro de una transacción:
   token válido → no ha votado → no expiró → votación abierta → hay una opción válida para **cada** moción →
   `UPDATE voters SET has_voted = 1 WHERE id = ? AND has_voted = 0` → una papeleta anónima por moción con el peso del votante.

### Cuestionarios
1. El admin crea el cuestionario (`SurveyCreateView.jsx`); cada pregunta se clasifica con `categorizeQuestion`
   (palabras clave en inglés y español) y queda a cargo de la persona destinataria.
2. La destinataria delega una pregunta, varias seleccionadas o una categoría (`delegateQuestions`).
3. La nueva persona responsable responde (`answerQuestion`). El progreso consolidado se calcula siempre
   a partir de las preguntas (`computeProgress`).

---

## 3. Casos borde: qué pasa si…

| Situación | Qué hace el sistema | Dónde |
|---|---|---|
| El CSV tiene una fila mala | Rechaza **todo** el archivo y lista cada error con fila y campo; no se guarda nada | `csvService.ts`, `adminRoutes.ts` |
| Hay un correo repetido en el CSV | Error `CSV_DUPLICATE_EMAIL` indicando la fila donde apareció primero | `csvService.ts` |
| Se agrega a alguien que ya estaba en la votación | 409 `VOTERS_ALREADY_EXIST`, no se importa nadie | `addVoters` |
| CSV con `;` o encabezados en español (Excel en español) | Se acepta; fechas DD-MM-AAAA también | `csvService.ts` |
| Adjunto `.exe` o un `.exe` renombrado a `.pdf` | Rechazado: lista de extensiones permitidas + revisión de los primeros bytes | `attachmentService.ts` |
| Nombre de archivo con `../../` | Se guarda como `<uuid>.pdf`; el nombre original solo se muestra | `attachmentService.ts` |
| El votante intenta votar dos veces | 403 `ALREADY_VOTED`; la interfaz muestra "Ya votaste" | `castBallot` |
| Dos pestañas envían el voto al mismo tiempo | Solo una pasa: el `UPDATE … WHERE has_voted = 0` cambia 1 fila en una sola (probado con 10 simultáneas) | `voting.test.ts` |
| Falta elegir una moción | 400 `INCOMPLETE_BALLOT`; además el botón está deshabilitado | `castBallot`, `VotingView.jsx` |
| Se envía una opción que no existe o una moción de otra votación | 400 `INVALID_OPTION` / `INVALID_MOTION`; la base de datos además lo impide con una clave foránea compuesta | `castBallot`, `schema.ts` |
| El enlace expiró (48 h) | 403 `TOKEN_EXPIRED`; el admin puede "Reenviar enlace", que genera uno nuevo e invalida el anterior | `rotateVoterToken` |
| La votación está cerrada | 403 `ELECTION_CLOSED`; se puede reabrir | `setElectionStatus` |
| Alguien inventa un token | 404 `INVALID_TOKEN` (se busca por hash; 256 bits no se pueden adivinar) | `votingService.ts` |
| ¿Se puede saber qué votó cada persona? | No: la tabla `ballots` no tiene referencia al votante, ni fecha, y su id es aleatorio | `schema.ts` |
| ¿Cómo sé que los resultados cuadran? | Por cada moción: suma de pesos de papeletas = suma de pesos de quienes votaron (insignia "Integridad verificada") | `getElectionDetail` |
| Quien no es responsable intenta responder | 403 `NOT_QUESTION_OWNER` | `answerQuestion` |
| Delegar una pregunta ya respondida | 409 `QUESTION_ALREADY_ANSWERED` | `delegateQuestions` |
| Delegar a uno mismo | 400 `DELEGATE_TO_SELF` | `delegateQuestions` |
| Delegar 3 preguntas y una no es mía | No se delega ninguna (todo o nada, transacción) | `delegateQuestions` |
| Dos responsables a la vez | Imposible: `current_owner` es **una sola columna** | `schema.ts` |
| Una persona ajena abre un cuestionario | 404 (no se revela que existe) | `getSurveyForViewer` |
| La sesión expira mientras se trabaja | El servidor responde 401, el cliente cierra la sesión y el login lo explica | `AuthProvider.jsx` |
| Un participante entra a `/admin` | La interfaz muestra "Sin acceso" y la API responde 403 | `ProtectedRoute.jsx`, `requireAdmin` |
| No hay SMTP configurado | Los correos se imprimen en la consola del servidor (modo simulado) | `emailService.ts` |
| Falla el envío a un destinatario | Se registra `failed` para esa persona y se sigue con el resto | `sendInvitations` |

---

## 4. Preguntas técnicas probables

**¿Por qué SQLite y no JSON?** Los JSON obligaban a reescribir archivos completos y a usar un candado propio.
SQLite da transacciones reales (todo o nada), claves foráneas y restricciones, sin instalar nada extra.

**¿Por qué las transacciones son funciones síncronas?** El driver `node:sqlite` es síncrono. Si dentro de una
transacción no hay `await`, ninguna otra petición puede ejecutarse a la mitad. El trabajo asíncrono (archivos,
correos) se hace antes o después.

**¿Por qué guardar el hash del token y no el token?** Si alguien copia la base de datos, no obtiene enlaces válidos.
Para validar, se calcula el hash del token recibido y se busca.

**¿Cómo se pondera?** El peso viene del CSV y se guarda en el votante. El cliente nunca lo envía. Cada papeleta
guarda ese peso y el resultado es `SUM(weight)` por opción.

**¿Cómo funciona el SSO?** Google firma un *ID token*; el servidor lo verifica con `jose` (firma con las claves
públicas de Google, emisor, audiencia = nuestro client id, expiración, `email_verified`). Después emite su propio JWT
HS256 firmado con `SESSION_SECRET`. El rol se recalcula en cada petición desde la configuración.

**¿Cómo funciona el multilenguaje?** `LanguageProvider` carga `es.json` y `en.json`; `t("seccion.clave", {param})`
busca la clave e interpola. No se usa ninguna API externa. `npm run check:i18n` verifica que ambos idiomas tengan
las mismas claves y que todas las claves usadas existan.

**¿Cómo se clasifican las preguntas?** Por palabras clave (prefijos, sin tildes, inglés y español). Gana la
categoría con más coincidencias; si no hay ninguna, `general`.

**¿Cómo se migraron los datos antiguos?** `db/legacyImport.ts` lee los JSON una sola vez, en una transacción, sin
modificarlos, y deja una marca en la tabla `meta` para no repetir. Los tokens se migran como hash: los enlaces
enviados siguen funcionando.

**¿Cómo se probó?** `deno task test` (35 pruebas que levantan la app real en memoria con `app.handle()`),
ESLint, `check:i18n`, build y pruebas en navegador a 390, 820 y 1440 px.

**¿Qué seguridad tiene la carga de archivos?** Lista de extensiones permitidas, revisión del contenido (firma del
archivo), nombre generado por el servidor, límite de tamaño y descarga con `X-Content-Type-Options: nosniff`.

---

## 5. Guion de demo (máx. 5 minutos, sin PPT)

1. Iniciar sesión con Google → mostrar el cambio ES/EN.
2. Nueva votación con 2 mociones → subir `samples/voters-with-errors.example.csv` (errores por fila) →
   subir `samples/voters.example.csv` → adjuntar un PDF → crear y enviar.
3. En la consola del servidor, mostrar el correo personalizado ("Estimada Sra. …", mociones, adjunto) y abrir su enlace.
4. Votar en el celular (o con la ventana angosta) → confirmar → recargar: "Ya votaste".
5. Detalle de la votación: resultados ponderados, integridad verificada, estado de los votantes, cerrar la votación.
6. Cuestionario: crear (clasificación en vivo) → delegar la categoría Finanzas → con "Actuar como" responder como
   la persona delegada → mostrar el progreso consolidado de la destinataria.
