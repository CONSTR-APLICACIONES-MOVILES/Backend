# Google login y ubicación de eventos

Estado de implementación local: 29 de octubre de 2026.

## Diagnóstico confirmado

- El proveedor Google está habilitado en `parchapp-ee6cc`, pero Flutter tenía el botón deshabilitado y el datasource devolvía un error fijo en vez de autenticar.
- Google Calendar inicializaba el singleton GoogleSignIn con un OAuth client de otro proyecto. Ahora login y Calendar comparten la inicialización con el client de `parchapp-ee6cc`; login no solicita permisos de Calendar.
- La configuración Firebase web también apuntaba al proyecto anterior. Se actualizó desde la configuración del web app existente `team-dashboard` del proyecto actual.
- El certificado del APK de este equipo no coincide con el registrado en Firebase. SHA-1 actual: `2E:31:83:95:E9:F6:B5:5B:D5:B7:0F:20:1B:DE:72:41:A2:7D:C0:D7`.
- La auditoría no encontró Maps SDK for Android ni Places API habilitados. La clave existente de Routes no sirve para esta integración y no se modifica.

## Implementación local

Flutter intercambia el ID token Google por una credencial Firebase, conserva el flujo de perfil existente y maneja cancelación, errores de configuración y cierre de sesión. Android utiliza el selector nativo de cuenta; web utiliza popup Firebase.

El formulario permite buscar lugares mediante Places SDK for Android, elegir un resultado, tocar el mapa o mover un pin. Se guardan etiqueta, latitud, longitud y placeId opcional en `locationDetails`. El detalle muestra el punto y permite abrir Google Maps. Cambiar manualmente el texto elimina las coordenadas anteriores para evitar incoherencias. No se solicita ubicación precisa del teléfono. La búsqueda inicial se centra en Bogotá y filtra Colombia.

El backend valida las coordenadas y su correspondencia con el texto. Las actividades anteriores con solo texto continúan funcionando. Los datos opcionales nuevos requieren actualizar `getActivity`, `publishActivity` y `updateActivityDetails`; no desplegar solo Flutter con escritura de coordenadas contra el contrato anterior.

Sin clave configurada se conserva la entrada manual y el selector explica que Maps no está disponible. El mapa requiere red. Esta integración nativa está preparada para Android; iOS aún necesita configuración propia del proyecto actual.

## Activación completada

El usuario aprobó explícitamente ambas operaciones y se completaron en `parchapp-ee6cc`:

1. Registrar SHA-1/SHA-256 del APK, habilitar los dos servicios y crear una clave restringida por paquete, certificados y APIs. Maps/Places pueden generar cargos por consumo.
2. Desplegar las tres funciones de actividades con el contrato de ubicación.

Los certificados están registrados y el archivo Firebase actualizado contiene el cliente OAuth del certificado actual (`oauthCertificatePresent: true`). Maps SDK for Android y Places API están habilitados. La clave `parchapp-android-maps` restringe paquete, los dos certificados SHA-1 aprobados y ambos servicios. Las tres funciones terminaron con `Successful update operation` y el despliegue con `Deploy complete`.

Comandos utilizados desde el directorio Backend:

```powershell
node scripts/configure-google-mobile.cjs --apply
.\node_modules\.bin\firebase.cmd deploy --only functions:getActivity,functions:publishActivity,functions:updateActivityDetails --project parchapp-ee6cc --account "$env:FIREBASE_ACCOUNT"
```

El script conserva certificados existentes y escribe la clave únicamente en `android/maps.properties`, ignorado por Git. No imprime claves ni tokens. Revisar `docs/google-mobile-configuration.json`, en particular `oauthCertificatePresent`, y recompilar el APK después de la configuración.

## Verificación y aceptación real

- Analizador Flutter: sin errores.
- Regresión Flutter: 269 pruebas aprobadas y una omitida.
- Backend: 43 pruebas aprobadas.
- Las pruebas cubren intercambio de token, cancelación, creación con Google, metadatos geográficos, selección y compatibilidad de actividades antiguas.
- APK con configuración activa compilado: `ParchApp-Flutter/build/app/outputs/flutter-apk/parchapp-google-location-debug.apk`.
- Prueba nativa real `tool/google_places_smoke.dart`: PASS en emulator-5554. Autocomplete devolvió cinco resultados; detalles devolvió University of the Andes, Cra. 1 #18A - 12, Bogotá, coordenadas `4.6014581, -74.0661334` y placeId. No creó cuentas ni actividades.
- Mapa real verificado visualmente con mosaicos y pin. Evidencia local Flutter: `build/google-map-live.png` y `build/google-places-live-smoke.log`.

Pendiente de aceptación con el usuario: elegir una cuenta Google, verificar Home y perfil, cerrar sesión y volver a entrar; crear un evento buscando un lugar, guardarlo, reabrirlo, comprobar el pin y editarlo. Cancelar el selector de cuenta debe conservar la pantalla de login sin un error de contraseña. La autenticación real con una cuenta del usuario todavía no se declara verificada. La conexión remota de Places y el mapa sí se verificaron.
