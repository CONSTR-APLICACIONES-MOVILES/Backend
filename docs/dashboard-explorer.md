# Explorador de BQ2, BQ3 y BQ14

## Qué cambió

El dashboard ahora tiene un explorador interactivo por encima de las tarjetas publicadas. Las tarjetas conservan su ventana original y el resto de BQs del equipo; los filtros del explorador actúan sobre una consulta nueva al backend, no cambian las demás tarjetas ni las recomendaciones operativas de la app.

| Pregunta | Filtros y vistas |
| --- | --- |
| BQ2: confiabilidad de creación | Fechas, últimos 7/14/30/90 días o rango personalizado; día/semana; porcentaje de fallos y timeouts, volumen por resultado y p95 de duración; tabla de familias de fallo |
| BQ3: aceptación de horarios | Lo anterior más tamaño de grupo, categoría y posición sugerida; aceptación intacta, modificación, no selección y pendientes; desglose por posición |
| BQ14: recordatorios | Fechas, día/semana, tamaño de grupo y estrategias de 30/60 minutos; exclusión opcional de planes ya confirmados al invitar; mediana/p95, confirmación y alertas por plan; tabla que compara las dos estrategias |

Se puede pulsar un punto del gráfico para consultar ese día/semana, desplegar la tabla de cohortes y exportar esa tabla a CSV. Cambiar la métrica del gráfico reutiliza la respuesta ya filtrada; cambiar fechas o segmentos requiere Apply filters y una consulta nueva. Reset vuelve a los valores iniciales.

## Correcciones de los estados de BQ3/BQ14

- Las tarjetas toleran arreglos o valores faltantes de agregados antiguos: no llaman `.map`, `.some` ni `.toFixed` sobre `undefined`/`null`.
- Los registros de BQ3 sin posición se clasifican como posición desconocida. No generan `NaN` ni pueden ser elegidos como posición recomendada.
- BQ14 distingue falta de muestra, cohortes pendientes de 24 horas, contaminación por confirmación inicial y muestra suficiente sin mejora conjunta. Antes `sufficient` reflejaba si existía ganador, confundiendo suficiencia de datos con superioridad de una estrategia.
- Seleccionar una sola estrategia muestra sus números, pero no la declara ganadora por falta de contraparte.
- Si no hay observaciones, la tasa y los tiempos son desconocidos (`—`); no se inventa 0%. Los gráficos dejan huecos donde no existe tasa medida.
- La ausencia de datos productivos o de instrumentación histórica no se arregla sembrando registros ficticios en producción.

## Cómo se calculan los filtros

`getActivityAnalytics` es un callable autenticado en `us-central1`. Acepta `question`, `from`, `to`, `granularity` y los filtros de segmentación correspondientes. El backend devuelve solo agregados; no entrega UID, ID de actividad, destinatarios, payloads ni observaciones individuales.

Se conserva la política existente: cualquier cuenta autenticada de ParchApp puede leer el dashboard; recalcular/publicar las tarjetas sigue requiriendo `orgAnalytics`. No se cambian reglas para permitir acceso anónimo ni lectura de telemetría cruda.

- Fechas inclusivas de calendario en **America/Bogota**, hasta 90 días por consulta. El servidor rechaza rangos invertidos, fechas inválidas/futuras y más de 10.000 registros fuente o entregas; se pide reducir el rango.
- Las semanas empiezan en lunes; las semanas de los extremos pueden ser parciales. Su fecha es el lunes, aunque el filtro empiece después.
- Las tasas semanales se calculan desde numeradores y denominadores de los registros, sin promediar porcentajes diarios.
- BQ2 agrupa por inicio del intento, BQ3 por exposición y BQ14 por invitación. Son cohortes con resultados observados en el momento de la consulta, no reconstrucciones exactas del conocimiento que existía en una fecha pasada.
- BQ14 espera 24 horas, distingue pendientes y desconocidos, incluye planes con cero avisos y calcula la velocidad solo entre confirmados. Enviar una alerta in-app no prueba recepción push. La comparación es observacional, no causal.
- Los tiempos de BQ14 se vuelven a calcular sobre los registros del segmento; no se promedian medianas de otros segmentos.
- Los históricos sin grupo/categoría aparecen en All/Unknown; un filtro específico los excluye y se informa cuántos registros quedaron fuera.
- Los controles no fabrican datos de periodos anteriores: solo permiten consultar los registros que realmente existan.

El explorador consulta registros vigentes en Firestore. Las tarjetas de debajo usan documentos publicados de `insights`, con su fecha de actualización y su ventana propia. Por eso sus cifras pueden diferir de una selección del explorador.

## Ejemplos de preguntas que ahora se pueden explorar

1. BQ2: ¿subieron los timeouts esta semana? Seleccionar 7 días, ver resultados por día y cambiar a p95 de duración.
2. BQ3: ¿se acepta más la primera posición para grupos de estudio de 2–3 personas? Filtrar categoría/tamaño y alternar posiciones; revisar muestra y porcentaje, no solo el porcentaje.
3. BQ14: ¿los grupos de 4–6 personas confirman antes con 30 minutos sin recibir más avisos? Elegir ambas estrategias, comparar mediana, confirmación y alertas por plan; revisar si cada brazo tiene muestra suficiente.

## Verificación local y datos de demostración

Iniciar Auth, Firestore y Functions con el proyecto fijo `demo-parchapp-analytics`, según las instrucciones del Emulator Suite. Desde Backend:

```powershell
npx firebase emulators:start --only auth,firestore,functions --project demo-parchapp-analytics
```

En otra terminal:

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
node scripts/seed-analytics-demo.cjs
python -m http.server 8787 --bind 127.0.0.1 --directory dashboard
```

Abrir `http://127.0.0.1:8787/?demoProject=demo-parchapp-analytics`. El script solo acepta emuladores loopback y un proyecto demo fijo. Crea una cuenta local de QA y fixtures de 28 días; sus credenciales de demostración están en ese script y no sirven en Firebase real. El dashboard identifica los datos como TEST DATA.

```powershell
npm --prefix functions test
node --test tests/activity.analytics.test.js tests/activity.metrics.test.js
```

Resultado del 24 de noviembre de 2026: 88 pruebas unitarias y 10 de integración aprobadas. Se verificaron en navegador las tres preguntas, cambios de fecha/granularidad, segmentación, tablas, ambas estrategias y selección vacía. La generación CSV está cubierta por pruebas; la descarga se invocó sin errores de consola, pero la herramienta de navegador no confirmó un archivo descargado. La vista de 334 px no presentó desbordamiento horizontal.

Las cifras de las capturas de prueba son fixtures locales, no resultados reales ni evidencia productiva.

## Despliegue pendiente

Estos cambios siguen locales en la rama Backend `feature/activity-drafts-sync`, junto a los cambios previos de borradores. No se hizo push ni despliegue de este explorador. Se necesita publicar tanto el backend como los archivos de Hosting para habilitarlo en la URL real.

Después de revisar el diff y el commit completo a desplegar:

```powershell
npx firebase deploy --project parchapp-ee6cc --only functions:getActivityAnalytics,functions:refreshActivityInsights,functions:refreshSlotRecommendation,hosting
```

El callable nuevo habilita las consultas flexibles. Los otros dos targets llevan los builders corregidos al refresco manual/programado de tarjetas. El dashboard sigue mostrando un error claro si el nuevo callable no existe o no es invocable; eso no se resuelve abriendo las reglas de Firestore. No ejecutar un deploy genérico de todas las funciones del equipo.

Esto es independiente del despliegue de borradores descrito en `activity-drafts.md`; publicar Hosting no sube ni instala Flutter.
