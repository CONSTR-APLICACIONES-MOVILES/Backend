# Emergencia Sprint 3: empalme Flutter/backend, BQ9 y bloqueos para demo

Destino: CONSTR-APLICACIONES-MOVILES/Backend. Asignar a `ga-pinto`.
Estado: borrador preparado. Crear mediante el conector devolvió 403 `Resource not accessible by integration`. Gabriel indicó que inició sesión, pero la automatización no pudo verificar una sesión utilizable y se detuvo al no poder validar la URL de Edge con confianza. No se declara issue publicado ni revisión del equipo recibida.

La revisión del 29/10/2026 identificó el backend y Flutter y dejó preparado el empalme del bloque 0 al bloque 1 de la entrega/viva 3.

Responsable de coordinación e implementación Flutter: ga-pinto. BQ9 Flutter elegida expresamente por Gabriel en esta sesión. Se conserva el crédito del SQL/BQ9 Java de Juan David en #2; no se declara autoría exclusiva ni aprobación docente.

## Repositorios y evidencia
- Backend: CONSTR-APLICACIONES-MOVILES/Backend, rama local main, base de5ef0a1df27d6313853a6d39cc2e9f55db7cdfc.
- Flutter: CONSTR-APLICACIONES-MOVILES/Sprint-2, rama feat/implementMetrics, base 8a53da0c6836d8d73762d291fd880bb2c84aebcc.
- Hay modificaciones locales de integración aún sin commit/PR; el código desplegado no equivale a un commit publicado.
- Firebase real: parchapp-ee6cc; Firestore (default); región Functions us-central1. Motor analítico actual: agregaciones de servidor sobre Firestore, no exportación BigQuery acreditada.
- Tablero encontrado: https://parchapp-ee6cc.web.app (HTTP 200). Su versión actual solo referencia BQ1/BQ3/BQ8; falta panel BQ9.
- Diez funciones de integración tienen código ACTIVE. Los dos callables nuevos aún responden 403 por permisos de invocación Cloud Run.
- No hay teléfono Android físico disponible (confirmado por Gabriel). ADB solo detecta emulator-5554.
- App Distribution: consultas de grupos/releases devuelven 404; distribución a TAs no acreditada.

## Criterios de cierre y responsables
- [x] Identificar repositorios, rama, remoto y bases locales. Responsable: ga-pinto.
- [x] Aceptar measurementVersion/comparisonEvidenceId en publishActivity, validar evidencia y conservar compatibilidad heredada. Responsable: ga-pinto. Prueba con cuatro payloads exportados desde ActivityDraft de Flutter y 40 pruebas backend aprobadas.
- [x] Seleccionar BQ9 para la implementación Flutter y separar crédito Java de #2. Responsable: ga-pinto, decisión del integrante.
- [ ] Revisión cruzada Java/Flutter de atribución (unknown frente a creación directa), cohorte madura a siete días y autoría separada. Revisión solicitada a @juandguzCasadiego; pendiente de respuesta, no se presume aceptación.
- [ ] Administrador de Firebase/Google Cloud: completar run.services.setIamPolicy/invocación de getCoordinationInsight, prepareProposalComparison y refreshCoordinationInsight. Cierre: dos callables sin sesión devuelven 401 UNAUTHENTICATED y con sesión funcionan; job nuevo configurado.
- [ ] ga-pinto + responsable tablero: añadir BQ9 al mismo tablero y BD existentes, con n/cobertura/dos tasas/diferencia/sin datos y fecha. Cierre: lectura autenticada real, sin CSV manual.
- [ ] ga-pinto: asegurar Android físico prestado y cable USB. Cierre: recorrido online/offline/reinicio en APK final sobre hardware.
- [ ] Responsable distribución por confirmar: configurar/verificar App Distribution, roster de TAs, release final e invitaciones. Cierre: destinatarios y acceso comprobados, más aviso requerido del curso.
- [ ] ga-pinto + revisor por confirmar: PR trazable de integración con validación, sin sobrescribir cambios de compañeros ni inventar commits/revisiones.
- [ ] ga-pinto: recorrido real organizador → crear → invitación → respuesta, con IDs verificables; BQ9 hasta motor y panel. Cierre del bloque 1 requiere evidencia autenticada, no solo compilación.

BQ9 no tiene actividades maduras en producción por ahora: debe mostrarse sin datos. No se insertarán cohortes ficticias en producción.

Bloqueos inmediatos: IAM de invocación, panel BQ9 compartido, teléfono físico y distribución. Este issue registra trabajo y solicitudes actuales; no atribuye respuestas ni revisiones que no han ocurrido.
