# Cuentas nuevas sin membresías de demostración

Corrección del 29 de octubre de 2026.

La función Auth `joinDemoGroupsOnSignUp` incorporaba cada registro a `roomies`, `eng`, `intramurals`, `thesis` y `choir`. Las consultas móviles calculan compañeros, grupos y actividades a partir de las membresías, por lo que una cuenta recién creada mostraba contenido que no había elegido.

`joinDemoGroups` ahora retorna antes de cualquier lectura o escritura cuando no se ejecuta en Firebase Emulator Suite. El trigger mantiene su nombre para actualizarlo sin eliminar infraestructura; los grupos reales requieren creación o aceptación explícita. El modo local conserva sus muestras para desarrollo.

Se retiraron exclusivamente las cinco membresías demo de la cuenta indicada por el usuario. La reparación usa precondiciones de versión de Firestore, conserva otros miembros y todos los documentos de cuenta, perfil y actividades; omite cualquier grupo donde la cuenta ya tenga contenido propio que requiera acceso. La verificación remota posterior devolvió cero grupos y cero compañeros para esta cuenta.

Herramienta de reparación: `scripts/remove-account-demo-memberships.cjs`. Sin `--apply` solo consulta. No ejecutar masivamente: no se revisó ni se autorizó modificar otras cuentas.

Pruebas backend: 44 aprobadas. La nueva regresión comprueba que un registro real no accede siquiera a los grupos, incluso si su UID tiene el prefijo de una muestra local.

Despliegue completado en `parchapp-ee6cc`: `joinDemoGroupsOnSignUp(us-central1)` informó `Successful update operation` y Firebase CLI confirmó `Deploy complete`.

Para refrescar Flutter, usar conexión a internet y cerrar/abrir la app o volver a iniciar sesión. La caché offline puede conservar una vista anterior si no hay conexión; las lecturas normales consultan primero el servidor. No es necesario borrar la cuenta ni reinstalar para esta corrección del backend.
