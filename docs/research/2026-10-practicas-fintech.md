# Prácticas de fintechs frente a nuestro backend (octubre 2026)

Investigación con búsqueda web y verificación adversarial: 26 fuentes leídas, 125 afirmaciones extraídas, las 25 más relevantes verificadas por tres revisores independientes (las 25 sobrevivieron 3 a 0). Después se contrastó contra el código del repositorio el 2026-10-07.

## Qué dicen las fuentes

| Práctica                                                                                                                                                                                                                                                                                          | Fuente                                                                                                                                                                                                                                     | Confianza |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| El dinero se registra en un libro mayor de doble partida: cada asiento suma cero, las tablas de asientos son solo de inserción y los errores se corrigen con asientos compensatorios. Square construyó Books porque sus tablas de entrada simple producían inconsistencias y depósitos demorados. | [Stripe, Ledger (2024)](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement); [Square, Books (2019)](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/) | Alta      |
| Reconciliación con cuentas de clearing: deben quedar en cero en estado estable; un evento faltante o tardío aparece como saldo distinto de cero.                                                                                                                                                  | Stripe, Ledger                                                                                                                                                                                                                             | Alta      |
| BOLA es el riesgo número 1 (API1:2023): chequeo de autorización por objeto en cada función que recibe un ID del usuario.                                                                                                                                                                          | [OWASP API Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)                                                                                                                                                         | Alta      |
| SSRF en webhooks (API7:2023): el cliente elige la URL que llama el servidor. Validar la IP resuelta en cada envío, no seguir redirects, no devolver nunca el cuerpo de la respuesta al usuario.                                                                                                   | OWASP; [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)                                                                                                                     | Alta      |
| Firma de webhooks según Standard Webhooks: se firma `msg_id.timestamp.payload`, con headers `webhook-id`, `webhook-timestamp` y `webhook-signature` (firmas versionadas para rotar secretos sin cortes); el receptor rechaza timestamps fuera de tolerancia.                                      | Standard Webhooks                                                                                                                                                                                                                          | Alta      |
| Límites por usuario y protección de flujos de negocio contra uso automatizado (API6:2023 y API4:2023).                                                                                                                                                                                            | OWASP                                                                                                                                                                                                                                      | Media     |
| Autenticación ligada al monto y al beneficiario ("dynamic linking"). Es derecho de la UE (PSD2, RTS 2018/389): **no obliga en Argentina ni en Brasil**; se usa como patrón de diseño.                                                                                                             | [EBA Q&A 2020_5247](https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2020_5247)                                                                                                                                             | Media     |
| "Canonical log lines": una línea de log estructurada por request al final, con request_id, usuario, rate limit, status, duración y cantidad de queries.                                                                                                                                           | [Stripe (2019)](https://stripe.com/blog/canonical-log-lines)                                                                                                                                                                               | Alta      |
| Nubank: microservicios desde el inicio, Clojure, arquitectura hexagonal, Datomic (base inmutable de hechos) y Kafka.                                                                                                                                                                              | [InfoQ](https://www.infoq.com/presentations/nubank-architectural-decisions); [Building Nubank](https://building.nubank.com/working-with-clojure-at-nubank/)                                                                                | Alta      |
| BCRA Com. A 8432 (BO 06/05/2026) crea la figura "PSPCP como Servicio"; el PSPCP sigue siendo responsable de KYC, PLA/FT, fraude, seguridad de la información y continuidad.                                                                                                                       | [BCRA A8432](https://www.bcra.gob.ar/archivos/Pdfs/comytexord/A8432.pdf)                                                                                                                                                                   | Alta      |

## Dónde estamos

**Bien, y en algunos puntos por encima de lo habitual:** `Money` en `bigint`; Unit of Work con locking optimista (el mismo mecanismo que el contador de versión de Square); outbox transaccional ordenado por wallet; idempotencia con reclamo previo, huella del request, fencing y finalización dentro de la transacción del dinero; sesiones en base con rotación de refresh; TOTP; guard de KYC. La dirección hacia hexagonal coincide con Nubank. El plan de `webhook-endpoint-security` ya cubre la validación de IP al conectar, los rangos privados y no seguir redirects.

**Falla, en orden de severidad:**

1. No hay libro mayor de doble partida: el saldo mutable es la fuente de verdad y no hay forma barata de reconciliar ni de probar que no se crea ni se destruye dinero.
2. SSRF y dueño de los webhooks: planificado, no implementado.
3. BOLA no auditado de forma sistemática.
4. La firma de webhooks no incluye timestamp (ya se envía `X-Webhook-Id`): vulnerable a replay y no interoperable.
5. Sin límites por usuario o nivel de KYC ni chequeos de velocidad.
6. Sin segundo factor ligado a monto y destino.
7. Sin request_id, logs canónicos, métricas, tracing ni bitácora de auditoría.
8. `exchange` e inversiones fuera de `Money` y del Unit of Work.
9. Secretos sin cifrar en reposo.
10. Paginación por OFFSET en el historial.

## Límites de esta investigación

- **No sobrevivió ningún dato técnico verificable** sobre Takenos, Belo, Ualá, Naranja X, Mercado Pago, PicPay, Inter ni Pix. Cualquier afirmación sobre sus stacks sería especulación.
- **Regulación incompleta:** solo se verificó la Com. A 8432. Quedan sin verificar UIF (PLA/FT), registro de PSAV ante la CNV para USDT, Ley 25.326, Pix y Open Finance del BCB, LGPD y PCI DSS 4.0. Las conclusiones regulatorias requieren revisión legal.
- Las fuentes de Square y de canonical log lines son de 2019: describen principios estables, no cómo operan esas empresas hoy.

## Preguntas abiertas

- ¿La wallet operará como PSPCP propio, sobre un "PSPCP como Servicio" o en Brasil vía un participante de Pix? Cambia quién carga con KYC, PLA/FT y fraude.
- ¿Qué exigen la UIF y la CNV a una wallet que custodia o intercambia USDT, en reportes y retención de registros?
- ¿Cómo modelar FX y USDT en el libro mayor (cuentas puente por par, precisión de 10^-8 frente a los decimales nativos de cada red) sin romper la regla de que cada asiento suma cero por moneda?
