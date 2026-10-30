# Conexión al Firebase actual — 29 de octubre de 2026

Proyecto indicado por el integrante y la captura: `parchapp-ee6cc`, número `718308941728`.

## Diagnóstico

- `.firebaserc` conservaba únicamente `demo-parchapp`. Se agregó alias `live` para `parchapp-ee6cc`. El default local se conserva para evitar dirigir scripts existentes accidentalmente a datos reales. Para consultas/despliegues live usar siempre `--project parchapp-ee6cc` explícito.
- Android migrado a `parchapp-ee6cc` en `lib/firebase_options.dart` y `android/app/google-services.json`, usando el archivo oficial compartido por el integrante. Paquete validado: `com.example.parchapp`. Web/iOS/macOS conservan configuración anterior y aún necesitan sus registros/configuraciones oficiales.
- Flutter ahora desactiva `USE_FIREBASE_EMULATORS` por defecto. Para pruebas locales, habilitar expresamente `--dart-define=USE_FIREBASE_EMULATORS=true`.
- Functions usa `initializeApp()` del Admin SDK sin proyecto fijo: al desplegar, utiliza el entorno del proyecto de destino. Esto no prueba que esté desplegado en el proyecto nuevo.
- La región cliente es `us-central1`; verificar que coincida con los despliegues reales.

## Consulta remota realizada

`firebase projects:list --json` terminó correctamente con lista vacía usando la sesión existente. `firebase functions:list --project parchapp-ee6cc --json` falló. Por tanto, no se acreditó acceso ni listado de funciones del proyecto nuevo. No se desplegó ni se modificaron datos remotos.

Comprobación HTTP posterior, sin token y sin datos de usuario, contra `https://us-central1-parchapp-ee6cc.cloudfunctions.net/`:

| Callable | Respuesta |
|---|---|
| getProfile | HTTP 401, UNAUTHENTICATED |
| getActivities | HTTP 401, UNAUTHENTICATED |
| getCoordinationInsight | HTTP 404 |
| prepareProposalComparison | HTTP 404 |

Los dos primeros endpoints están accesibles y requieren autenticación; esto no prueba todavía el recorrido autenticado ni acceso correcto a Firestore. Los dos últimos no están disponibles en esas URLs/región. Sigue pendiente acceso administrativo para inventariar y desplegar el backend faltante.

## Auditoría autenticada posterior (cuenta confirmada por el integrante)

El acceso con `gabriel.ropinto@gmail.com` ya funciona. El fallo anterior correspondía a otra sesión y no representa el estado actual. Se consultaron las apps y funciones con `--account` explícito.

- 49 funciones activas; región `us-central1`, consistente con el cliente. Inventario resumido en `firebase-live-functions.json`.
- Registro Android confirmado con app ID `1:718308941728:android:117a10f675ea5500998ec5`, paquete `com.example.parchapp`. La configuración Android, Dart y metadatos FlutterFire corresponden a ese registro.
- Firestore `(default)` existe, modo nativo, ubicación `nam5`.
- Firebase Authentication tiene habilitados correo y contraseña.
- La API BigQuery devuelve HTTP 200 con cero datasets visibles para esta cuenta/proyecto. No demuestra ausencia en otros proyectos o fuera de sus permisos, pero no acredita el dataset usado por el pipeline.
- Functions expone `ANALYTICS_DATASET=analytics_000`; `refreshTeamInsights` y `refreshTeamInsightsNightly` tienen `analytics_PROPERTY_ID`. No corresponden a un dataset visible verificado.
- El escaneo de llamadas literales del cliente encuentra dos endpoints ausentes: `getCoordinationInsight` y `prepareProposalComparison`.
- `ActivityDraft.publication()` añade `measurementVersion=1` y puede añadir `comparisonEvidenceId`; la whitelist local de `publishActivity` no los admite. Esto es una incompatibilidad local comprobada, aún no una prueba autenticada de publicación en nube. No eliminar esos campos silenciosamente ni aceptarlos sin implementar su semántica de medición.
- `refreshTeamInsights` y su job existen en nube pero no se encontraron sus implementaciones en el `functions/index.js` local revisado. No realizar despliegue global desde esta copia: primero preservar/reconciliar las funciones del equipo.
- `npm run test:functions`: 26 pruebas aprobadas en esta revisión, sin emuladores. No sustituyen pruebas autenticadas ni comprueban toda la API/reglas.
- `flutter analyze --no-pub` finalizó con código 0: `No issues found! (ran in 64.0s)`. Esto valida análisis estático, no compilación ni ejecución en teléfono.

Auditoría reproducible de configuración, sin documentos de usuarios:

```powershell
node scripts/audit-live.cjs gabriel.ropinto@gmail.com
```

Resultado resumido en `firebase-live-audit.json`; usa credenciales solo en memoria y no las imprime. El inventario de funciones es una instantánea que debe actualizarse tras despliegues.

## Siguiente integración

Actualización posterior: ver `INTEGRACION_ANALITICA_SPRINT3.md`. El integrante aprobó el despliegue de diez funciones; su código ya está `ACTIVE`, sin placeholders en la configuración de esas diez funciones. La analítica real publica agregados desde Firestore y se comprobó su ejecución. Persisten HTTP 403 en los dos callables nuevos porque la cuenta no tiene `run.services.setIamPolicy` para completar la invocación Cloud Run. El listado de pasos que sigue describe la situación anterior a esa implementación; consultar el documento de integración para el bloqueo vigente.

1. Recuperar/reconciliar el backend de BQ9 declarado en el cierre y el código del dashboard que ya está desplegado; no sobrescribir funciones compartidas.
2. Implementar conjuntamente contrato de publicación, evidencia de comparación y medición; pruebas de validación/idempotencia antes de despliegue acotado.
3. Identificar el motor analítico compartido real (incluido otro proyecto si aplica) y sustituir placeholders únicamente con IDs verificados.
4. Probar login y flujo móvil autenticado contra nube con cuentas de prueba; no usar tokens CLI como si fueran tokens de Firebase Auth.
5. Compilar y probar el APK final en teléfono físico. Web/iOS/macOS siguen pendientes de configuración del proyecto nuevo.

No afirmar que una cuenta de facturación activa acredita acceso, despliegue o integración. La captura confirma la identidad del proyecto, no esos estados.
