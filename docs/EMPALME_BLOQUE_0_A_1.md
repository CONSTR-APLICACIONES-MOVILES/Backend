# Empalme del bloque 0 al bloque 1 — 29/10/2026

## Dictamen

El rechazo de campos de medición está resuelto y probado. El bloque 0 está parcialmente cerrado: repositorios, BQ Flutter, backend, proyecto/BD y URL del tablero identificados. Faltan habilitar invocación IAM, publicar el issue, conseguir teléfono y acreditar distribución. Puede avanzarse en preparación y pruebas; no se acredita aún el recorrido móvil autenticado completo del bloque 1.

## Estado de cada criterio

| Criterio | Estado y evidencia | Cierre pendiente |
|---|---|---|
| Repositorio Flutter | `CONSTR-APLICACIONES-MOVILES/Sprint-2`, raíz local `MovsLocal/Sprint-2`, rama `feat/implementMetrics`, HEAD `8a53da0c6836d8d73762d291fd880bb2c84aebcc`; remoto origin HTTPS del mismo repositorio. | Las modificaciones de integración están sin commit/PR. No declarar que ya se publicaron. |
| Repositorio backend | `CONSTR-APLICACIONES-MOVILES/Backend`, rama `main`, HEAD `de5ef0a1df27d6313853a6d39cc2e9f55db7cdfc`; remoto origin HTTPS del mismo repositorio. | Código adicional y documentación aún sin commit/PR; no cambiar de rama ni mezclar trabajo de compañeros automáticamente. |
| Backend BQ9 y comparación de versiones | PR #2 de Juan David está fusionado: SQL BQ9 sobre eventos, sin `unknown` ni cohorte madura a siete días. No era equivalente al backend completo que declaraba el cierre del 26. Se implementó el contrato faltante de recibos/medición y se recuperó `teamInsights.js` desde el código desplegado. | Revisar en PR la coexistencia del SQL Java histórico y la medición Flutter de servidor. No borrar crédito ni mezclar definiciones sin documentarlo. |
| BQ individual | Gabriel decidió expresamente continuar BQ9 en Flutter, separada del aporte Java de Juan David. BQ3/BQ13 permanecen como antecedentes de sprint 2. Wiki y contrato actualizados con esa distinción. | No se inventa aprobación docente ni revisión de compañeros; conservar el reparto de aportes en la entrega. |
| Proyecto/BD/motor | `parchapp-ee6cc`, número `718308941728`; Firestore `(default)`, ubicación `nam5`; Functions `us-central1`. Pipeline real: agregación servidor sobre Firestore. No hay dataset BigQuery visible/verificado. | No usar `analytics_000` o `analytics_PROPERTY_ID` como una integración real. La dependencia activa se retiró en las diez funciones desplegadas. |
| Permisos de backend | Diez funciones con código `ACTIVE`; publicación/edición acepta medición. Los nuevos callables `getCoordinationInsight` y `prepareProposalComparison` siguen en HTTP 403 de plataforma. | Administrador debe completar invocación con `run.services.setIamPolicy`; después verificar 401 sin sesión y éxito con Firebase Auth. El job diario nuevo también requiere completar configuración. |
| Tablero único | URL verificada HTTP 200: https://parchapp-ee6cc.web.app. Fuente: rama `feature/team-dashboard`, commit `707af82`, trabajo de Tatiana; PR #4 documenta Hosting. Actualmente solo BQ1/BQ3/BQ8. | Añadir BQ9 al tablero existente leyendo `insights/bq9_comparison_confirmation`; comprobar acceso con cuenta de la app. HTTP 200 no acredita login. |
| Teléfono | Gabriel confirmó que no tiene Android físico disponible. `adb devices -l` solo detecta `emulator-5554`, un dispositivo virtual. | Conseguir prestado un Android y cable; autorizar depuración e instalar el mismo APK que se distribuya. |
| Distribución | Cuenta/proyecto consultados; endpoints de grupos y releases App Distribution devolvieron 404. | No se confirma ausencia absoluta del servicio, pero no hay evidencia de release/invitaciones a TAs. Confirmar responsable, roster y permisos; distribuir después de probar el APK final. |
| Issue de emergencia | Texto completo preparado en `docs/emergency/ISSUE_EMERGENCIA_SPRINT3.md`, dueño propuesto `ga-pinto`, checklist y cierres por tarea. El conector GitHub devolvió 403 `Resource not accessible by integration`. | Publicarlo desde una sesión con permisos y guardar URL. Gabriel informó que inició sesión; la automatización del navegador no pudo verificar una sesión utilizable y se detuvo al no poder validar la URL con confianza. No se publicó ni se enviaron solicitudes al equipo. |

## Contrato Flutter/backend: evidencia nueva

`tool/export_publication_contract.dart` usa el `ActivityDraft.publication()` real de Flutter. Exporta cuatro escenarios a `Backend/functions/test/fixtures/flutter-publication.json`: creación directa, propuesta con comparación, slot programado y cliente heredado.

La prueba backend pasa esos payloads por `createMobileCallables(...).publishActivity.run()`, incluida la whitelist real, validación de recibos, escritura de medición y replay. Comprueba `false`, `true`, `true` y `null` respectivamente; un campo desconocido sigue siendo rechazado. No se retiraron `measurementVersion` ni `comparisonEvidenceId` para esconder el desacuerdo.

Comandos, desde Flutter:

```powershell
& 'C:/Users/gabri/flutter/bin/cache/dart-sdk/bin/dart.exe' tool/export_publication_contract.dart '../../Backend/functions/test/fixtures/flutter-publication.json'
flutter test --no-pub test/core/sprint3_completion_test.dart --reporter compact
flutter test --no-pub test/core/offline_mobile_api_test.dart --reporter compact
```

Desde Backend: `npm run test:functions`.

Resultados de esta revisión: **40 pruebas backend, 5 pruebas Flutter de cierre y 23 pruebas Flutter offline aprobadas**. El backend usa un doble transaccional que exige lecturas antes de escrituras; no se afirma que esa prueba simule toda la concurrencia real de Firestore ni que verifique tokens HTTP. El modo productivo de la app es Firebase cloud; no se inició Firebase Emulator Suite para estas pruebas.

## Empalme concreto con el bloque 1

1. **Cerrar IAM antes del recorrido BQ9.** Reintentar únicamente la configuración de los tres servicios afectados cuando el administrador otorgue permisos. No deshabilitar autenticación ni abrir reglas de Firestore para sortear 403.
2. **Versionar y revisar los cambios.** Preparar commits/PR de los cambios actuales por repositorio, enlazados al issue una vez publicado. Separar configuración Firebase, contrato/medición y documentación; incluir el enlace al PR #2 Java y al PR #4 del tablero. No atribuir commits o revisiones que todavía no existen.
3. **Recorrido online con dos cuentas de prueba.** Organizador crea actividad → participante recibe y responde → reabrir detalle → verificar IDs y reconocimiento servidor. Empezar por creación directa, luego comparación con slot y sin huecos comunes. No confundir `accepted` de un invitado con `CONFIRMED` de la actividad.
4. **BQ9 hasta el panel común.** Añadir la tarjeta al dashboard existente con las dos tasas, diferencia en puntos porcentuales, n, cobertura y ventana. El agregado ya existe en la BD real. Cero actividades maduras implica sin datos; no fabricar una cohorte productiva para la entrega.
5. **Demo offline reproducible.** Preparar Details y Alerts online; desconectar; navegar por copias; guardar respuesta pendiente; reiniciar; reconectar; confirmar replay. Las 23 pruebas automáticas pasaron, pero falta ejecutarlo en hardware. El emulador Android permite ensayo, no sustituye el teléfono exigido.
6. **APK físico y distribución.** Conseguir el dispositivo, verificar el APK final contra nube y después App Distribution con destinatarios del curso. No declarar cerrado este criterio con un emulador o un APK local.

## Guion de preparación oral mientras llegan accesos/teléfono

- **Mi aporte:** BQ9 Flutter, contexto de comparación que sobrevive al borrador, recibo de servidor consumido por publicación idempotente, primera confirmación y agregado compartido. Reconocer SQL Java previo de Juan David y dashboard de Tatiana.
- **Conectividad:** una respuesta pendiente significa intención local persistida; se confirma solo tras reconocimiento servidor. Explicar reintento, conflicto, descarte y separación por cuenta/proyecto.
- **Concurrencia:** `compute` procesa JSON grande en isolate nativo; la cadena de Futures serializa escrituras. Async no implica por sí solo otro hilo.
- **Caché/persistencia:** límite por entradas y orden de escritura; no afirmar LRU por acceso. SharedPreferences acredita persistencia demostrable, no automáticamente toda la puntuación de almacenamiento.
- **Métrica:** actividades maduras a siete días, unknown separado de creación directa, denominador vacío sin datos; diferencia observada no demuestra causalidad.

## Enlaces de evidencia

- Backend PR #2: https://github.com/CONSTR-APLICACIONES-MOVILES/Backend/pull/2
- Dashboard PR #4: https://github.com/CONSTR-APLICACIONES-MOVILES/Backend/pull/4
- Tablero: https://parchapp-ee6cc.web.app
- Auditorías locales: `firebase-live-verification.json`, `firebase-delivery-access.json`, `INTEGRACION_ANALITICA_SPRINT3.md`.

No están acreditados todavía: issue publicado, revisión de compañeros, invocación completa de BQ9, tarjeta BQ9 publicada en el tablero, dispositivo físico o distribución a los TAs.
