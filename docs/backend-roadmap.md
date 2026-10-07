# Roadmap del backend

Estado y orden de lo que falta para que PayPayPay sea una API que se pueda presentar a un cliente. Cada cambio pasa por OpenSpec (plan, aprobación, TDD, verificación) antes de implementarse. Este documento solo ordena; el detalle vive en `openspec/changes/<cambio>/`.

Última revisión: 2026-10-07. Incorpora la investigación de [`docs/research/2026-10-practicas-fintech.md`](research/2026-10-practicas-fintech.md). Todo lo marcado como hecho o hueco fue verificado contra el código en esa fecha.

## Qué significa "API robusta" aquí

Criterios con los que se decide el orden. Un cambio sube de prioridad si cierra una de estas brechas con dinero de por medio.

1. **El dinero no se duplica ni se pierde.** Reintentos seguros, atomicidad, concurrencia probada con invariantes.
2. **El dinero es exacto.** Nunca `number`; una sola representación (`Money`) de punta a punta.
3. **Cada movimiento se puede explicar.** Doble entrada: toda variación de saldo tiene su contrapartida.
4. **Solo el dueño opera su dinero.** Autorización por recurso, pasos extra para operaciones sensibles, límites por usuario.
5. **Los eventos salen con garantías.** Outbox transaccional, firma, endpoints verificados.
6. **El contrato es estable y claro.** Errores consistentes, paginación que escala, documentación OpenAPI completa, versionado.
7. **Se puede operar.** Logs estructurados con identificador de petición, métricas, bitácora de auditoría.

## Hecho

| Cambio                                                                                                                | Estado                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Money` con `bigint`, sin librería decimal (ADR 0002)                                                                 | Mergeado                                                            |
| Unit of Work + outbox transaccional + relay con reintentos (ADR 0001)                                                 | Mergeado                                                            |
| Idempotencia: reclamo previo, lease con token de fencing, finalización dentro de la transacción del dinero (ADR 0003) | Implementado y verificado en `feat/idempotency-store`; PR por abrir |

## En curso o con plan escrito

| Cambio                                                                                                | Estado                                                 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `webhook-endpoint-security` (dueño del endpoint, validación de destino, alcance de eventos; ADR 0004) | Plan en `feat/webhook-endpoint-security`; PR por abrir |
| Instrucciones para agentes (`AGENTS.md`) con la regla de `Money` y el outbox                          | `docs/agents-md`; PR por abrir                         |

## Orden propuesto

El orden respeta dependencias: cada paso usa lo que dejó el anterior.

1. **`exchange-on-money`.** `exchange` todavía usa `Prisma.Decimal` sin truncar y su propia transacción. Pasa a `Money.convertTo` (trunca a favor de la plataforma), al Unit of Work y al outbox.
2. **`investment-on-money`.** Compra y venta sobre `Money`, Unit of Work, locking optimista e idempotencia. Hoy no tienen ninguna de las tres cosas.
3. **`webhook-endpoint-security`** (implementación). Sube al primer lugar si la API está expuesta a internet. El plan ya cubre la validación de IP al conectar (DNS rebinding), los rangos privados y no seguir redirects. La investigación agrega dos puntos: **no devolver nunca el cuerpo de la respuesta del endpoint al usuario** y un **desafío de verificación de propiedad** del endpoint. En el despliegue: IMDSv2 obligatorio si se corre en la nube.
4. **`bola-audit`.** BOLA es el riesgo número 1 de OWASP API 2023. Auditoría sistemática: los repositorios exigen el dueño en cada consulta (`findByIdForUser(id, userId)`) y una suite e2e con dos usuarios prueba acceso cruzado en cada ruta que recibe un ID. Barato y de alto impacto.
5. **`double-entry-ledger` + `internal-transfer`.** Hoy `send` solo debita a un beneficiario externo: **no existe una transferencia entre dos usuarios de la plataforma.** Diseño según Stripe y Square: asientos que suman cero por moneda, tablas solo de inserción (sin `UPDATE`/`DELETE` a nivel de rol de PostgreSQL), correcciones con asientos compensatorios, el saldo de la wallet como caché derivada actualizada en la misma transacción, y **cuentas de clearing** (depósito pendiente, retiro en tránsito, puente FX) con un job que alerta cuando quedan distintas de cero. Usa la idempotencia ya construida.
6. **`canonical-logs`.** Primer paso de observabilidad, el más barato (Stripe): `request_id` propagado en `X-Request-Id` y una línea de log estructurada por request y por entrega de webhook, con usuario, idempotency key, resultado del rate limit, status, duración y cantidad de queries. Métricas y tracing vienen después.
7. **`transaction-authorization`.** Segundo factor ligado al monto y al destino (patrón "dynamic linking" de PSD2, usado como diseño y no como obligación legal local), y límites **por usuario** según nivel de KYC y velocidad de gasto. Hoy el único límite es el del throttler: 60 peticiones por minuto **por IP**.
8. **`load-test`.** Prueba de carga con k6 y verificación de invariantes al final (suma de saldos conservada, una transacción por clave, ningún saldo negativo, clearing en cero). Sin invariantes, "5000 peticiones concurrentes" no demuestra nada. Hay que desactivar el throttler en ese entorno. Hoy no hay ninguna prueba de carga en el repositorio.
9. **`cursor-pagination`.** `GET /transactions` usa `skip`/`take` más `count` (paginación por OFFSET), que se degrada con historiales grandes; el módulo de portfolio ya usa cursor. Cambia el contrato de la respuesta, así que el plan debe decidir cómo convivir con los clientes actuales (versión nueva o parámetros compatibles).
10. **`webhook-delivery-v2`.** Formato [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md): se firma `msg_id.timestamp.payload` con los headers `webhook-id`, `webhook-timestamp` y `webhook-signature` (firmas versionadas para rotar el secreto sin cortes), tolerancia de timestamp contra replay y un verificador de ejemplo. Hoy ya se envía `X-Webhook-Id`, pero la firma no incluye timestamp. Además, reintentos de varios días.

### Decisión pendiente: ¿el libro mayor antes de `exchange` e inversiones?

La investigación ubica la falta de doble partida como la falla más grave. Si `exchange` e inversiones se migran primero a `Money` y al Unit of Work, después habrá que volver a tocarlos para que generen asientos. Hacer el libro mayor primero evita ese doble trabajo; el costo es que el error de redondeo de `exchange` (acredita sin truncar) sigue vivo más tiempo. Una alternativa intermedia es corregir solo el truncamiento de `exchange` ahora y dejar el resto para cuando exista el libro mayor.

### Pregunta de negocio que cambia prioridades

¿La wallet opera como PSPCP propio, sobre un "PSPCP como Servicio" (BCRA Com. A 8432, mayo 2026) o en Brasil vía un participante de Pix? En los dos primeros casos, la bitácora de auditoría, los límites, la prevención de fraude y el cifrado en reposo dejan de ser buenas prácticas y pasan a ser exigencias. Requiere revisión legal.

## Candidatos sin plan todavía

Cada uno necesita primero una verificación en el código y un plan.

- **Bitácora de auditoría** de operaciones sensibles.
- **Observabilidad, segunda etapa**: métricas (réplicas, conflictos y takeovers de idempotencia, entregas `dead`) y tracing con OpenTelemetry, sobre los logs canónicos.
- **OpenAPI completo**: `@ApiOperation` y `@ApiResponse` en los endpoints clave (la lista vieja lo deja sin marcar).
- **Cifrado en reposo** de secretos (por ejemplo, secretos de webhooks).
- **Higiene de e2e** (`openspec/changes/e2e-hygiene`).
- **Documentación de despliegue** y alineación del README (menciona Railway; la imagen se publica en GHCR).

## Descartado, con motivo

| Idea                                          | Por qué no                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cola de notificaciones con BullMQ y DLQ       | El outbox ya da reintentos persistidos y estado `dead` **dentro de la misma transacción que el dinero**. Una cola en Redis no puede comprometerse junto con esa transacción. Solo se reconsidera para notificaciones no críticas. |
| `idempotencyKey` en el cuerpo de la petición  | La práctica de Stripe, Adyen y el borrador del IETF es un header (`Idempotency-Key`). Así vale para cualquier endpoint sin tocar los DTO.                                                                                         |
| `SELECT ... FOR UPDATE` en las transferencias | El proyecto usa locking optimista con columna `version`; cambiarlo requiere un ADR y no hay evidencia que lo justifique.                                                                                                          |
