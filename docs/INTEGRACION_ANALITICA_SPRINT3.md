# Integración de comparación y analítica — 29 de octubre de 2026

## Arquitectura preparada

Proyecto: `parchapp-ee6cc`, Firestore `(default)`, funciones en `us-central1`.
Se usa el motor de agregación del equipo sobre Firestore: los datos operativos y registros del servidor alimentan documentos de solo lectura en `insights`. No se depende de un dataset BigQuery ficticio ni se presenta la exportación de Google Analytics como habilitada.

El código de `teamInsights.js` se recuperó del ZIP de la función `refreshTeamInsights` ya desplegada. Se conservaron BQ1/BQ8 y la respuesta previa del botón de actualización; se añadieron contadores de BQ9/BQ5. BQ3 conserva su job y contrato anteriores. La instantánea descargada permanece en `tmp/deployed-team/`, excluida de Git.

## Endpoints y datos

- `prepareProposalComparison({date, friendIds})`: requiere autenticación; uno a diez compañeros distintos de grupos compartidos. Valida permisos de disponibilidad y calendarios conocidos, incluso si todos están ocupados. Devuelve `{comparisonEvidenceId, participantIds, date}`. No devuelve intervalos privados. El recibo expira a los 30 minutos.
- `validatePlanningSlot`: sigue validando un intervalo libre; añade evidencia de uso de comparación con la misma caducidad de cinco minutos del slot. No convierte una simple apertura de Schedule en comparación.
- `publishActivity`: admite `measurementVersion: 1` y `comparisonEvidenceId`. Verifica dueño, participantes, día cuando hay intervalo, grupo, caducidad y consumo del recibo. Evidencia y medición se guardan en la misma transacción idempotente de publicación. Un recibo no se puede reutilizar en otra actividad.
- `getCoordinationInsight({})`: requiere autenticación y devuelve `{insight: ...}` o `{insight: null}` cuando aún no hay agregado. Coincide con el panel Flutter existente.
- `recordFirstActivityConfirmation`: trigger con la política normal de entrega, sin activar reintentos persistentes de fallos, contempla cambios compatibles de Java. Conserva la primera confirmación frente a entregas duplicadas y desordenadas. La creación/confirmación por los callables escribe la medición en transacción; las ediciones directas heredadas dependen de la entrega correcta del trigger.
- `refreshCoordinationInsight`: job diario 04:45 Bogotá. El botón existente `refreshTeamInsights` también recalcula BQ9 y BQ5.

Colecciones nuevas, solo servidor: `coordinationComparisons` y `coordinationMeasurements`. Las reglas locales no contienen permisos cliente para ellas; no se amplían reglas ni se dan permisos públicos como parte de este cambio. Confirmar las reglas realmente desplegadas antes de presentar la seguridad extremo a extremo como acreditada.

## BQ9

Agregado: `insights/bq9_comparison_confirmation`.

- Uso: actividades con comparación / actividades con atribución conocida.
- Cobertura: atribución conocida / total de la cohorte. Clientes heredados quedan `unknown`, nunca se convierten automáticamente a creación directa.
- Confirmación: primera transición dentro de siete días desde creación, incluyendo creación ya confirmada.
- Cohorte: treinta días completos de creación que terminan siete días completos antes de hoy, en Bogotá. Se excluyen registros marcados explícitamente `analyticsEnvironment: test` o mediciones con `environment: test`.
- Se publican n, desconocidos, dos tasas, diferencia en puntos porcentuales, ventana y actualización. Denominador vacío produce `null`/sin datos.
- Las actividades históricas sin medición cuentan como desconocidas; no se inventa evidencia ni confirmaciones históricas. Cambios nuevos sí quedan instrumentados.

No se llenó producción con datos de muestra. Una cohorte vacía o todavía inmadura es un resultado válido y se debe explicar en la demostración. La diferencia es asociación, no causalidad.

## BQ5: sustitución del dataset inexistente

El job anterior consultaba una exportación `events_*` de BigQuery que no estaba configurada. Ahora consume invitaciones/respondidos reconocidos por servidor (`inboxes/.../items/...`) para actividades creadas durante los últimos treinta días. Incluye respuestas que se sincronizaron después de trabajar offline.

La interfaz `insights/bq5_response_time` conserva campos, umbrales y estimaciones usados por Flutter. Deduplica por invitado/actividad; la finalización exige respuestas de todos los invitados, excluyendo al organizador del número de personas que deben contestar. No hay respuesta si no existe reconocimiento de servidor. Los tamaños y duración derivan de registros reales; la mediana usa rango inferior exacto en lugar de la aproximación de BigQuery. Esta población por fecha de creación sustituye la antigua ventana por fecha del evento: documentar ese cambio al comparar resultados anteriores. Para clientes heredados sin `participantIds`, se usa la membresía actual del grupo, limitación conocida.

Se eliminó `ANALYTICS_DATASET` de `functions/.env` y su declaración de parámetros en el entry point. Los SQL en `functions/sql/` se conservan como referencias históricas para una futura exportación configurada; sus placeholders no se ejecutan en el pipeline actual. La dependencia BigQuery existente se conserva por compatibilidad del lockfile, pero el entry point ya no la usa.

## Validación y despliegue

Pruebas sin emuladores: `npm run test:functions`, 39 aprobadas. Cubren atribución directa/heredada, caducidad/consumo, permisos, reintentos, recorrido de slot, primera confirmación, cohortes, desconocidos, ceros y respuestas BQ5. No equivalen a una prueba de la aplicación en teléfono.

Alcance de despliegue preparado: `getCoordinationInsight`, `prepareProposalComparison`, `validatePlanningSlot`, `publishActivity`, `updateActivityDetails`, `recordFirstActivityConfirmation`, `refreshCoordinationInsight`, `refreshResponseTimeInsight`, `refreshTeamInsights`, `refreshTeamInsightsNightly`.

Estado verificado tras aprobación explícita del integrante: las diez funciones tienen código desplegado y estado `ACTIVE`. Las tres nuevas funciones HTTP `getCoordinationInsight`, `prepareProposalComparison` y `refreshCoordinationInsight` no completaron configuración de invocación: el CLI no pudo establecer IAM. Los dos callables responden HTTP 403 antes del handler; la tarea NO se declara completada para uso móvil.

Se comprobó `testIamPermissions` en los tres servicios nuevos: la cuenta tiene `run.services.getIamPolicy`, pero no `run.services.setIamPolicy`. Los dos callables tampoco tienen binding público de invocación. Debe resolverlo un administrador; no se deshabilitó IAM ni se abrieron reglas de datos para rodear la restricción.

El job existente `refreshTeamInsightsNightly` sí se ejecutó correctamente a las 16:49 Bogotá del 29 de octubre. Publicó BQ1, BQ8, BQ5 y BQ9 en Firestore. BQ5 procesó cuatro invitaciones reales; BQ9 tiene cero actividades maduras y produce métricas sin datos. No se insertaron fixtures. Sus agregados fueron leídos con HTTP 200 desde la API de Firestore. Evidencia: `firebase-live-verification.json` y `firebase-live-job-diagnostic.json`.

Las diez funciones revisadas ya no contienen `ANALYTICS_DATASET` en sus variables desplegadas. La política de reintentos persistentes del trigger se retiró tras el rechazo automático de `--force`; el despliegue aprobado se ejecutó sin esa opción. Las reglas Firestore desplegadas se recuperaron e inspeccionaron: coinciden con las locales y no conceden acceso cliente directo a las colecciones nuevas.

Siguiente paso obligatorio: un administrador debe permitir que esta cuenta gestione la política de invocación de los tres servicios (permiso `run.services.setIamPolicy`; por ejemplo mediante un rol apropiado de Cloud Run), o completar directamente los bindings de invocación. Después repetir el despliegue de esos tres servicios para completar también el job diario nuevo, comprobar HTTP 401 `UNAUTHENTICATED` de los callables sin sesión y verificar el flujo con Firebase Auth real. Los valores de `ANALYTICS_DATASET` de funciones no incluidas en este despliegue pueden seguir en metadatos antiguos, pero no son una fuente analítica válida.

Acción para el propietario: Google Cloud → IAM, proyecto `parchapp-ee6cc`, editar permisos de `<FIREBASE_ACCOUNT>` y conceder un rol que incluya `run.services.setIamPolicy` en los servicios afectados. `Cloud Run Admin` (`roles/run.admin`) es un rol estándar que lo incluye; puede asignarlo a nivel de los tres servicios para limitar el alcance. No hace falta volver a pagar Firebase ni compartir claves de cuentas de servicio.
