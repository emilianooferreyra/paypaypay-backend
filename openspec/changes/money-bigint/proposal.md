## Por qué

El ADR 0002 decidió (2026-10-01, opción B) que `Money` se represente con enteros de punto fijo, como hacen los APIs líderes revisados (Stripe, Adyen, Monzo) y el libro mayor TigerBeetle, y que nuestro código deje de depender de una librería decimal. Hoy `Money` usa `decimal.js`, que solo se importa en `src/shared/kernel/money.ts`.

Al verificar el código para este plan aparecieron tres defectos que el cambio también corrige:

1. **Una wallet con un saldo muy chico no se puede cargar.** `PrismaWalletRepository` lee el saldo con `Money.restore(row.balance.toString())`. El `Decimal` de Prisma imprime en notación exponencial los valores menores a 10⁻⁶ (`0.00000001` sale como `1e-8`), y `Money` rechaza esa notación. Verificado con el `Decimal` de Prisma: `0.0000001`, `0.00000001` y `0.00000005` fallan; `1.0005` no. El resultado es un error al operar con esa wallet. Es un defecto del adaptador que se mergeó en el PR #8.
2. **No hay tope de monto.** Postgres rechaza en `NUMERIC(20,8)` todo valor de 10¹² o más con `numeric field overflow` (verificado), que hoy llegaría al cliente como un 500.
3. **`toString()` redondea.** Muestra el monto con los decimales de la moneda y redondea half-up si el valor tiene más precisión (un saldo heredado de `1.0005 USD` se muestra `1.00`). Es correcto para mostrar y peligroso para escribir en la base. Hoy los adaptadores solo lo usan con montos ya validados, pero nada impide el error.

## Qué cambia

- **`Money` se reimplementa por dentro con `bigint` de punto fijo.** La resolución interna es 10⁻⁸ (`LEDGER_SCALE = 8`), la misma escala de la base de datos. La API pública no cambia: `of`, `zero`, `restore`, `add`, `subtract`, `convertTo`, `equals`, `isLessThan`, `isGreaterThanOrEqual`, `isZero`, `isNegative`, `getCurrency`, `toString`.
- **Se agrega `toLedgerString()`**: el valor exacto con 8 decimales, sin notación exponencial y sin redondeo. Es lo único que se usa para escribir en la base.
- **Se agrega un tope**: todo monto y todo resultado de una operación debe ser menor que 10¹². Si no, `AmountTooLargeError`, que `toMoney` traduce a 400.
- **Los adaptadores de Prisma** leen con `toFixed(8)` (nunca `toString()`) y escriben con `toLedgerString()`.
- **Se elimina `decimal.js`** de `dependencies`, y una regla de ESLint prohíbe importarlo, para que no vuelva a entrar sin una decisión.
- **Pruebas diferenciales**: la implementación nueva se compara contra `Prisma.Decimal` (misma aritmética que la librería actual, presente sin dependencia nueva) con una secuencia pseudoaleatoria de semilla fija, además de casos de borde fijos.
- Sin cambios en el esquema de la base ni en las respuestas HTTP.
- **BREAKING**: ninguno hacia afuera. Un monto de 10¹² o más pasa de 500 a 400.

## Capacidades

### Nuevas
- `money-representacion`: cómo se construye un `Money`, su resolución interna, los límites y la forma de mostrarlo.
- `money-operaciones`: suma, resta, comparación y conversión de moneda.
- `money-frontera-persistencia`: cómo cruza el valor entre `Money` y Prisma sin pérdida ni notación exponencial.

### Modificadas
- *(ninguna; no hay specs de dinero en `openspec/specs/`)*

## Impacto

- **Código**: `src/shared/kernel/money.ts` y su spec; `to-money.ts` (nuevo error); `prisma-wallet.repository.ts` y `prisma-transaction.repository.ts`; `package.json` y `pnpm-lock.yaml`; `eslint.config.mjs`.
- **Base de datos**: ninguna migración.
- **Orden**: va **antes** de `exchange-on-money` e `investment-on-money`, para que esos dos adopten la representación final una sola vez.
- **Fuera de alcance**: pasar `exchange` e `inversiones` a `Money`, columnas `BIGINT` en la base, el libro mayor, y el formato con que `GET /wallet` serializa saldos diminutos (hoy devuelve el `Decimal` de Prisma tal cual; queda anotado como seguimiento).
