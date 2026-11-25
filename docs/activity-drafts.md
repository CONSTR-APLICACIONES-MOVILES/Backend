# Borradores privados: contrato y despliegue

## Estado y cambios

Rama Backend: `feature/activity-drafts-sync`. Rama Flutter: `feature/mis-borradores` en el repositorio Sprint-2. Código preparado y probado con emuladores; sin commit/push/merge a main ni despliegue realizados en esta tarea.

Los borradores se guardan primero en SQLite y se sincronizan con Firestore. Los nuevos callables son aditivos; no cambian los campos ni la firma de `publishActivity`. No requieren crear colecciones manualmente ni un índice compuesto nuevo.

| Callable autenticado | Entrada | Salida |
| --- | --- | --- |
| `getActivityDrafts` | `{cursor?}` | `{drafts:[{id,version,state,category,payload,requestId,activityId,updatedAt}],nextCursor}`. Hasta 50 registros/página, incluye tombstones |
| `syncActivityDraft` | `{id,operationId,expectedVersion,state,category,payload,requestId?,clientUserId?}` | ACK con ID, versión, estado, categoría, fecha y referencia de publicación; no incluye texto histórico |

Región: `us-central1`. El propietario viene de Firebase Auth. `clientUserId`, si aparece, debe coincidir con Auth. No se acepta un owner enviado por el cliente. Se rechazan campos inesperados, IDs inválidos, categorías/estados inválidos y payloads de más de 64 KiB. Los borradores activos admiten título/grupo/horario incompletos; las validaciones finales permanecen en la publicación de actividad.

## Persistencia y concurrencia

Firestore guarda el estado actual en `privateDraftOwners/{uid}/drafts/{id}`. Los recibos idempotentes están en su subcolección `operations/{operationId}`. Retienen hash y ACK sin texto histórico del plan.

Cada operación compara `expectedVersion` en una transacción y aumenta la versión. Reintentar una operación idéntica devuelve su ACK original. Usar el mismo ID de operación para otro contenido devuelve `already-exists`. Una versión obsoleta devuelve `aborted`; un plan cerrado no puede resucitar mediante un guardado activo.

Eliminar conserva un tombstone con payload nulo. Publicar exige un recibo real en `activityCommands/{uid}/requests/{requestId}` y una actividad creada por el UID. `privateDraftOwners/{uid}/publications/{requestId}` impide acreditar una misma actividad a dos borradores. Un fallo de sincronización del cierre no revierte la actividad publicada: se reintenta el cierre posteriormente.

Las reglas niegan lectura/escritura directa a la colección privada, incluidos sus recibos y enlaces. El Admin SDK de las funciones aplica el contrato de autorización, no esas reglas de cliente. Los clientes reciben sus borradores a través de callables autenticados.

## Prueba intermedia ejecutable sin desplegar

Desde Backend, con Java 21+ seleccionado:

```powershell
npx firebase emulators:start --only auth,firestore,functions --project demo-parchapp-drafts
```

En otra terminal de Backend:

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
node --test tests/activity.drafts.test.js tests/activity.metrics.test.js tests/activity.metrics.rules.test.js
npm --prefix functions test
```

En Flutter:

```powershell
flutter analyze --no-pub
flutter test --no-pub test/features/activities test/architecture_test.dart --dart-define=DRAFTS_EMULATOR_TEST=true
```

El test HTTP de Flutter usa dos archivos SQLite independientes y tokens del Auth Emulator contra las Functions y Firestore locales. Comprueba envío offline/online, recuperación desde otra instalación, privacidad entre cuentas y eliminación propagada. No apunta a Firebase real. Las pruebas de backend verifican autorización, versiones, reintentos, publicación reconocida, paginación y reglas. Los permisos denegados en los tests de reglas son resultados esperados.

Ejecución del 24 de noviembre de 2026: 104 pruebas Flutter aprobadas con el test HTTP habilitado; 82 unitarias de Functions y 14 de contrato/reglas aprobadas; analizador Flutter limpio y `git diff --check` sin errores en ambos repositorios. Los emuladores usaron un proyecto `demo-`; no se hicieron escrituras en producción.

## Secuencia para subir y desplegar después

1. Revisar y guardar los cambios de **ambos repositorios** en sus ramas; hacer push y PR/merge en cada uno. No incluir `.env*`, logs, claves ni las notas personales ignoradas. La configuración de cliente Firebase no es una credencial Admin.
2. Obtener en el equipo de despliegue (tu computador o Cloud Shell) el commit exacto de Backend ya revisado. Si usas Cloud Shell, `git pull` allí solo actualiza archivos: todavía no despliega.
3. Revisar el diff completo de `firestore.rules` frente a las reglas desplegadas del equipo. Desplegar únicamente estos componentes al proyecto real explícito:

```powershell
npx firebase deploy --project parchapp-ee6cc --only functions:getActivityDrafts,functions:syncActivityDraft,firestore:rules
```

No ejecutar el deploy genérico de todas las funciones ni Hosting para este cambio. No usar el alias default: en este repo es `demo-parchapp`. Confirmar después que las funciones existen en `us-central1` y que una llamada autenticada funciona. Si la invocación devuelve 403, comprobar la configuración de invocación y los logs; no abrir las reglas de Firestore para resolver un error del transporte de Functions.

4. Compilar/instalar la app Flutter que contiene la sincronización:

```powershell
flutter run -d <device-id> --dart-define=USE_FIREBASE_EMULATORS=false
```

5. Con una cuenta de prueba real, guardar un borrador y esperar **Saved in your cloud account**. Comprobar el documento en Firestore. Recuperarlo en otra instalación de la misma cuenta, editar offline y reconectar, eliminar y verificar la propagación. Otra cuenta no debe verlo. Publicar y verificar una sola actividad y el cierre del borrador. No basta con matar y reabrir la app: eso también puede recuperar SQLite.
6. Generar el APK validado y distribuirlo. La comparación temporal no debe reaparecer después de terminar el proceso, aunque los borradores privados sí puedan recuperarse del servidor.

Hasta completar los pasos 3–5 no se declara funcionando en producción. Fusionar Flutter con main no despliega Functions ni habilita la persistencia remota por sí solo. Mientras las funciones nuevas no estén disponibles, los cambios continúan locales y la UI debe mostrar sincronización pendiente.

## Referencias oficiales

- [Conectar Functions al Emulator Suite](https://firebase.google.com/docs/emulator-suite/connect_functions)
- [Conectar Firestore al Emulator Suite](https://firebase.google.com/docs/emulator-suite/connect_firestore)
- [Administrar y desplegar funciones específicas](https://firebase.google.com/docs/functions/manage-functions)
- [Firebase App Distribution para Android](https://firebase.google.com/docs/app-distribution/android/distribute-cli)
