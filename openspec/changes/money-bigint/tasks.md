TDD estricto: primero la prueba que falla (se la ve fallar), después el mínimo código, después la limpieza. Una rama desde `main`. Cada corrida de e2e necesita el consentimiento del mantenedor para el reinicio de `authdb_test`. Este cambio va **antes** de `exchange-on-money` e `investment-on-money`.

## 1. Línea base y reproducción del defecto

- [x] 1.1 Registrar el estado actual: los 23 tests de `Money`, `pnpm typecheck`, la suite unitaria completa y el e2e completo en verde
- [x] 1.2 RED: prueba de integración contra Postgres con una wallet de saldo `0.00000005 USD` (y `0.0000001`, `0.00000001`); depositar en ella **falla hoy** con `InvalidAmountError`. Verlo fallar antes de seguir
- [x] 1.3 RED: prueba de integración de un depósito de `1000000000000` — hoy responde 500 por `numeric field overflow`

## 2. Pruebas del comportamiento nuevo (todas en rojo)

- [x] 2.1 RED: tabla fija de casos de borde de `of`, `restore`, `toString`, `toLedgerString` y `toJSON` (cada escenario de `money-representacion`)
- [x] 2.2 RED: el tope de 10¹² en entrada, suma, resta y conversión, positivo y negativo; `AmountTooLargeError`
- [x] 2.3 RED: `toMoney` traduce `AmountTooLargeError` a 400 con el máximo en el mensaje y mantiene los 400 anteriores
- [x] 2.4 RED: la tabla de conversión (`100 ARS × 0.001`, `1000.50 ARS × 0.001 → 1.00`, negativo, tasas inválidas, mismo moneda, 36 dígitos)
- [x] 2.5 RED: pruebas diferenciales contra `Prisma.Decimal` con generador de semilla fija (mulberry32 o similar, sin dependencia): al menos 2000 casos por operación y moneda; un fallo imprime semilla y entrada

## 3. Reimplementación de `Money`

- [x] 3.1 GREEN: `ledgerUnits: bigint`, `LEDGER_SCALE = 8`, parseo de texto a `bigint` sin `number`, constructor privado único con la verificación de tope
- [x] 3.2 GREEN: `add`, `subtract`, comparaciones, `isZero`, `isNegative`, `equals`
- [x] 3.3 GREEN: `convertTo` con tasa entera, división de `bigint` y truncado a los decimales de la moneda destino
- [x] 3.4 GREEN: `toString` (half-up solo para mostrar), `toLedgerString`, `toJSON`
- [x] 3.5 Los 23 tests originales y todos los nuevos pasan; la API pública no cambió (el typecheck de todo el repo lo demuestra)

## 4. Frontera con Prisma

- [x] 4.1 `PrismaWalletRepository` lee con `toFixed(8)`; las pruebas de 1.2 pasan
- [x] 4.2 Ambos repositorios escriben con `toLedgerString()`
- [x] 4.3 Prueba de ida y vuelta (escribir con `toLedgerString`, leer con `toFixed(8)`) con valores de borde
- [x] 4.4 La prueba de 1.3 pasa: ahora responde 400
- [x] 4.5 Adición fuera del plan original: un depósito que dejaría el saldo por encima del tope responde 422 (`DepositService` suma el saldo y el monto con `Money` antes de acreditar, porque la base incrementa el saldo por su cuenta y `Money` nunca veía el resultado)

## 5. Quitar la librería

- [x] 5.1 RED: una regla de ESLint de `no-restricted-imports` sobre `decimal.js`; comprobar que falla con un import deliberado y que lo retiro
- [x] 5.2 Eliminar `decimal.js` de `dependencies` y actualizar `pnpm-lock.yaml`; confirmar que `pnpm install --frozen-lockfile` y el build funcionan
- [x] 5.3 Confirmar que nada más importa `decimal.js` y que Prisma sigue leyendo y escribiendo `Decimal`

## 6. Documentación

- [x] 6.1 ADR 0002: estado a "implementado", actualizar la tabla "Dónde se usa y dónde no" y el glosario con los nombres reales
- [ ] 6.2 `AGENTS.md`: la regla de dinero ahora dice `bigint` de punto fijo, sin librería decimal — **pendiente**: `AGENTS.md` vive en la rama `docs/agents-md`, que todavía no se mergeó; se actualiza ahí
- [x] 6.3 Anotar en el ADR el seguimiento del formato de `GET /wallet` para saldos diminutos

## 7. Verificación

- [ ] 7.1 `pnpm typecheck`, `pnpm lint:ci` (sin errores nuevos en los archivos del PR), `pnpm test`, `pnpm test:e2e` (con consentimiento), `pnpm build` y `docker build --target prod`
- [ ] 7.2 Recorrer cada escenario de las tres specs y registrar cómo se verificó
- [ ] 7.3 Abrir el PR con la tabla de verificación y la lista de lo que no se hizo a propósito
