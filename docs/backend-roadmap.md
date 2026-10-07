# Roadmap del backend

Estado y orden de lo que falta para que PayPayPay sea una API que se pueda presentar a un cliente. Cada cambio pasa por OpenSpec (plan, aprobación, TDD, verificación) antes de implementarse. Este documento solo ordena; el detalle vive en `openspec/changes/<cambio>/`.

Última revisión: 2026-10-06. Todo lo marcado como hecho o hueco fue verificado contra el código en esa fecha.

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
3. **`webhook-endpoint-security`** (implementación). Sube al primer lugar si la API está expuesta a internet.
4. **`double-entry-ledger` + `internal-transfer`.** Hoy `send` solo debita a un beneficiario externo: **no existe una transferencia entre dos usuarios de la plataforma.** Una transferencia wallet a wallet obliga a tener libro mayor de doble entrada, y es el caso más reconocible de una fintech. Usa la idempotencia ya construida.
5. **`transaction-authorization`.** Segundo factor ligado al monto y al destino, y límites **por usuario** según nivel de KYC y velocidad de gasto. Hoy el único límite es el del throttler: 60 peticiones por minuto **por IP**.
6. **`load-test`.** Prueba de carga con k6 y verificación de invariantes al final (suma de saldos conservada, una transacción por clave, ningún saldo negativo). Sin invariantes, "5000 peticiones concurrentes" no demuestra nada. Hay que desactivar el throttler en ese entorno. Hoy no hay ninguna prueba de carga en el repositorio.
7. **`cursor-pagination`.** `GET /transactions` usa `skip`/`take` más `count` (paginación por OFFSET), que se degrada con historiales grandes; el módulo de portfolio ya usa cursor. Cambia el contrato de la respuesta, así que el plan debe decidir cómo convivir con los clientes actuales (versión nueva o parámetros compatibles).
8. **`webhook-delivery-v2`.** Firma con marca de tiempo (Standard Webhooks / Stripe), reintentos de varios días, rotación de secretos.

## Candidatos sin plan todavía

Cada uno necesita primero una verificación en el código y un plan.

- **Autorización por recurso** (BOLA): suite de pruebas con dos usuarios sobre todos los recursos. Se confirmó en wallet; falta en portfolio.
- **Bitácora de auditoría** de operaciones sensibles.
- **Observabilidad**: identificador de petición en logs y respuestas, métricas de réplicas, conflictos y takeovers de idempotencia.
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
