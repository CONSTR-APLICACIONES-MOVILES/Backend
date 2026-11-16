# Integración BQ14, privacidad y compatibilidad con main

## Estado verificable (30 de octubre de 2026)

Código integrado localmente sobre `feat/bq14` y `origin/main` 7ee2b72. El push de la rama y el despliegue son pasos independientes; resolver el merge local no publica Firebase ni fusiona el PR #10 en main.

Verificación HTTP de producción, sin guardar tokens ni datos de perfil: una cuenta de prueba autorizada consiguió inicio de sesión 200 y `getProfile` 200 con el UID correspondiente. Sin token, `getProfile` y `publishActivity` devolvieron JSON 401 UNAUTHENTICATED. `setUsername` devolvió 403 HTML; `getFriends` respondió 401 no JSON aun con token Firebase, y `getResponseTimeEstimates` 404. Estos últimos no cumplieron el contrato callable. No confundir esos fallos de publicación/permisos con una contraseña incorrecta. La consulta administrativa `functions:list` no pudo completarse con la sesión CLI disponible.

## Publicar desde la rama de trabajo

Desde la raíz de Backend:

```powershell
git status
git push origin feat/bq14
npm ci
npm --prefix functions ci
npm run test:functions
npx firebase login
npx firebase use parchapp-ee6cc
```

Antes del despliegue, configurar `ANALYTICS_DATASET` con el dataset **real** de la exportación Analytics en `functions/.env.parchapp-ee6cc` (por ejemplo el nombre `analytics_...` obtenido de la consola). El scheduler BQ6 de main lo requiere. No usar el valor del ensayo local ni subir credenciales de servicio. Confirmar la cuenta CLI y el proyecto.

Un administrador debe provisionar `orgAnalytics: true` como custom claim de Auth exclusivamente para los miembros autorizados de la organización, conservando sus demás claims. El perfil editable, el correo enviado en un request y una sesión de un usuario normal no otorgan este permiso. Renovar el token o cerrar/iniciar sesión en el dashboard después de provisionarlo. Coordinar este paso con la publicación de las reglas: las cuentas sin claim perderán acceso al dashboard por diseño. No se asignó ningún claim en producción durante este trabajo.

```powershell
npx firebase deploy --only functions,firestore:rules,firestore:indexes,hosting --project parchapp-ee6cc
```

Los endpoints de aplicación verifican Firebase Auth y pertenencia en el handler. Si un endpoint devuelve HTML 401/403 antes de ejecutar el handler, revisar su servicio de Cloud Run/Cloud Functions y su política de invocación con el administrador. Un token Firebase de usuario y una credencial IAM de invocación son mecanismos distintos. No cambiar todos los invocadores en bloque. El error histórico `iam.serviceAccounts.ActAs` requiere que el administrador revise la capacidad de la cuenta que despliega para actuar como la cuenta de ejecución indicada por Firebase; no se modificaron permisos IAM aquí.

## Conectar Flutter y recuperar la sesión

En `ParchApp-Flutter`:

```powershell
flutter run -d emulator-5554 --dart-define=USE_FIREBASE_EMULATORS=false
```

Android y web usan `parchapp-ee6cc`, Functions en `us-central1`, y Auth/Functions de la misma FirebaseApp. No reutilizar una ejecución compilada con USE_FIREBASE_EMULATORS=true para probar la nube. Un usuario de emulador, una tarjeta guardada o un nombre mostrado no prueban que exista una sesión válida en producción. Cerrar sesión e iniciar con email/clave del proyecto real si la tarjeta reconocida falla. No es necesario borrar la base offline ni reinstalar para renovar Auth.

El arranque dibuja un spinner antes de esperar Firebase. El transporte renueva una sola vez el token al recibir `unauthenticated`, con comprobación de UID antes de reintentar. El perfil distingue sesión inválida, permisos, función ausente y servicio inaccesible. Esto no sustituye el despliegue pendiente de funciones sociales.

Comprobar después de publicar: getProfile devuelve el UID activo; setUsername y búsqueda/amistad funcionan entre dos cuentas; un usuario normal recibe permission-denied al leer insights o getCoordinationInsight; una cuenta de organización ve las cards y puede refrescar. No registrar tokens ni contraseñas como evidencia.

## Contratos conservados al resolver el PR

- BQ3: los `candidates` de Java mantienen exactamente el orden mostrado. El servidor valida intervalos y calcula disponibilidad. El ranking generado por el servidor conserva Strategy y la realimentación BQ13.
- BQ6: publicaciones legacy sin `measurementVersion: 1` mantienen el timing por destinatario de main y su exploración estable.
- BQ14: publicaciones programadas con `measurementVersion: 1` congelan la política 30/60 minutos por actividad. Un solo dispatcher transaccional entrega BQ6/BQ14 y recordatorios personales, conserva metadatos para Alerts y evita duplicar contadores.
- Dashboard: conserva BQ1/7/8/9 del equipo y las cards BQ2/3/13/14. Agregados privados mediante claim orgAnalytics; servicios Admin siguen consumiéndolos para decisiones de producto.
- Flutter recibe únicamente estimaciones BQ5 aplicables a sus grupos mediante `getResponseTimeEstimates`; no lee la colección insights.
- Java debe incorporar el cambio local de `FirestoreInsightsRepository`/`Repositories`: usa `getRecommendedSlotPosition` para su badge BQ3, sin leer el agregado privado. Publicar este callable antes o junto con las reglas nuevas. Clientes Java antiguos caerán en el badge por defecto hasta actualizarse.

## Patrones y puntos concretos

| Patrón o técnica | Uso verificable | Límite |
|---|---|---|
| Strategy | `functions/src/activityService.js`: inyección `ranker`; `availability.js`: ContextAwareSlotRankingStrategy; Java SlotRanker con OverlapRanking, PreferenceRanking, SoonestRanking, seleccionadas en CompareAvailabilityController | No llamar Strategy a cada if ni atribuir la estrategia Java al trabajo nuevo |
| Repository / Adapter | ActivityRepository separa Firestore del servicio; Flutter MobileApi y repositorios traducen DTO a entidades; Java InsightsRepository mantiene el contrato y cambia su adaptador a callable | Un repositorio no es una caché por sí solo |
| Cache-aside + LRU persistente | Flutter `lib/core/data/offline_mobile_api.dart`: _remember, cacheCapacity=64, lectura con fecha, fallback y _invalidateAfterMutation; SQLite/Preferences aislados por proyecto y UID | Límite de entradas, no de bytes; una copia offline no es una lectura fresca |
| Observer | ValueNotifier/ValueListenableBuilder y streams de conectividad/Auth actualizan vistas y estado offline | No supone sincronización en tiempo real de todos los datos |
| Command / idempotencia / outbox | requestId y activityCommands; expectedVersion en amistad; journal y cola local; creation_attempt_monitor conserva intentos | Cola local no implica envío de WhatsApp ni push |
| Transacción | Reserva de username, amistad, creación y despacho de recordatorios; aviso/contador/recibo se confirman juntos | Evidencia de entrega in-app, no acuse de una notificación externa |
| Concurrencia / isolate | Cola serializada de SQLite y offline_document_codec para JSON grande en plataformas nativas | Concurrencia es una técnica, no un patrón GoF |

Las mediciones locales son ensayos. La muestra productiva, scheduler desplegado, teléfono físico y prueba completa de UI Java/Flutter siguen pendientes.


## Verificaciones locales

75 pruebas unitarias del backend y 107 de integración/reglas aprobadas en puertos aislados. La restricción adicional de analítica por actividad pasó las 16 pruebas de su suite afectada. Flutter: suite de 289 pruebas aprobada (1 omitida preexistente), cuatro casos nuevos de mensajes del perfil aprobados; análisis sin incidencias y APK debug construido. Java: compileDebugJavaWithJavac aprobado. Estas comprobaciones no ejecutan el cron cloud ni sustituyen teléfono físico.
