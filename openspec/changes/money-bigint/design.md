## Contexto

`Money` es hoy un objeto de valor inmutable (monto y moneda inseparables) construido sobre `decimal.js`. El ADR 0002 decidió reemplazar esa representación por enteros de punto fijo. Este documento fija cómo, y deja explícito qué se mantiene igual.

**Fuentes** (nivel 1 y 2 de la jerarquía del proyecto, verificadas el 2026-10-01):

- Documentación de Stripe, Adyen y Monzo: los montos viajan como enteros en la unidad mínima de la moneda.
- Documentación de TigerBeetle: montos como enteros sin signo de 128 bits; la **escala del activo** se elige con cuidado porque no se cambia con facilidad; en un cambio de moneda se redondea **a favor de la cuenta de liquidez** para evitar arbitraje.
- Consultas hechas contra el `Decimal` de Prisma y contra PostgreSQL para este plan (ver la propuesta): notación exponencial por debajo de 10⁻⁶ y rechazo de valores de 10¹² o más en `NUMERIC(20,8)`.

## Decisiones

### D1. Una sola escala interna, igual a la de la base

| Opción | Ventajas | Desventajas |
|---|---|---|
| A. Escala distinta por moneda (como Stripe: 2 decimales para USD, 6 para USDT) | Es exactamente el "entero en unidad mínima" de las APIs | Un saldo heredado como `1.0005 USD` no cabe en 2 decimales; cada conversión entre monedas obliga a reescalar; la escala de un activo no se cambia fácil (advertencia de TigerBeetle) |
| **B. Escala única de 8 decimales para todas (elegida)** | Cualquier valor que guarde la base (`NUMERIC(20,8)`) es representable; las conversiones no reescalan entre monedas; no hay que decidir una escala por moneda | La validación de decimales por moneda pasa a los bordes (entrada y salida) |

Se elige B. El entero interno se llama `ledgerUnits` y vale `valor × 10⁸`. **No** se llama `minorUnits` ni `cents`: en Stripe, Adyen y Monzo la unidad mínima depende de la moneda, y la nuestra no (glosario completo en el ADR 0002).

### D2. Todo parseo es de texto a `bigint`, sin pasar por `number`

La entrada es siempre un `string`. Se valida con el mismo patrón de hoy (`-?\d+(\.\d+)?`, sin notación científica, sin espacios), se separa parte entera y fraccionaria, y se arma el `bigint` con la fracción completada a 8 dígitos. Ningún valor pasa por `number` ni por `parseFloat`. Es la propiedad que justifica todo el cambio.

### D3. Dos formas de construir y por qué siguen siendo dos

- `Money.of(texto, moneda)`: entrada de un cliente. Rechaza más decimales de los que admite la moneda (`PrecisionError`).
- `Money.restore(texto, moneda)`: un valor ya guardado. Admite hasta 8 decimales aunque la moneda admita menos, porque la base puede tener montos de antes de que existiera la regla (`1.0005 USD`, polvo de conversiones). Más de 8 decimales es imposible en `NUMERIC(20,8)` y se rechaza como valor inválido.

### D4. Aritmética y conversión

- Suma, resta y comparaciones son operaciones directas de `bigint` entre valores de la misma moneda; otra moneda lanza `CurrencyMismatchError`.
- **Conversión**: la tasa llega como texto positivo. Se convierte a un entero `tasaEntera` y una cantidad de decimales `d`, y el resultado es `ledgerUnits × tasaEntera ÷ 10^d`. La división de `bigint` trunca hacia cero. Después se trunca a los decimales de la moneda destino (potencia de 10 de la diferencia con la escala interna). Truncar dos veces hacia cero sobre grillas alineadas da el mismo resultado que truncar una vez, así que es **idéntico** al `ROUND_DOWN` actual, y coincide con la dirección que recomienda TigerBeetle: el cliente recibe de menos, nunca de más.
- Las tasas se limitan a 36 dígitos en total para que una entrada absurda no genere números gigantes.

### D5. Mostrar no es escribir

| Método | Para qué | Comportamiento |
|---|---|---|
| `toString()` | Mostrar | Con los decimales de la moneda; si el valor tiene más precisión, redondea half-up (como hoy) |
| `toLedgerString()` | **Escribir en la base** | Exacto, siempre 8 decimales, sin redondeo y sin notación exponencial |
| `toJSON()` | Evitar un error | `JSON.stringify` de un `bigint` lanza una excepción; `Money` se serializa como su `toString()` |

Los adaptadores usan **solo** `toLedgerString()` para escribir. Mantener el half-up de `toString()` conserva el comportamiento actual y es una decisión consciente: mostrar `1.00` para `1.0005 USD` es lo esperado en pantalla.

### D6. Tope de monto

Un valor válido cumple `|valor| < 10¹²`, el límite de `NUMERIC(20,8)`. Se verifica en **un único lugar**, el constructor privado por el que pasan todas las rutas (entrada, suma, resta, conversión), así ninguna operación puede producir un valor que la base rechace. Lanza `AmountTooLargeError`; `toMoney` lo traduce a 400 con un mensaje claro. Los negativos se permiten (un libro mayor necesita las dos direcciones).

### D7. Cómo se prueba una aritmética propia

Escribir aritmética a mano es el riesgo de este cambio. Se mitiga con tres capas:

1. Los 23 tests actuales de `Money`, que fijan el comportamiento y deben seguir pasando sin cambios.
2. **Pruebas diferenciales** contra un oráculo: `Prisma.Decimal`, que implementa la misma aritmética decimal que la librería actual y viene con Prisma, así que no hay dependencia nueva y el oráculo sobrevive a la eliminación de `decimal.js`. Un generador pseudoaleatorio de semilla fija (determinista, reproducible) produce miles de montos y tasas por operación, y se comparan los resultados como texto exacto.
3. Una tabla fija de casos de borde: cero, negativos, `0.00000001`, el máximo, un decimal de más, `1000.50 ARS × 0.001 → 1.00 USD` (truncado, no `1.0005`).

### D8. La frontera con Prisma

- **Leer**: `Money.restore(row.balance.toFixed(8), moneda)`. `toFixed` nunca usa notación exponencial; `toString` sí.
- **Escribir**: `new Prisma.Decimal(money.toLedgerString())`.
- Se agrega una prueba de integración contra Postgres que **primero reproduce el defecto actual** (una wallet con saldo `0.00000005 USD` no se puede cargar) y después queda como prueba de regresión.

### D9. Quitar la librería y que no vuelva sin decidirlo

Se elimina `decimal.js` de `dependencies`. Prisma sigue trayendo su propia copia, por eso el oráculo de pruebas existe. Una regla de ESLint (`no-restricted-imports`) prohíbe `import ... from "decimal.js"` en todo el código propio, con un mensaje que remite al ADR 0002.

### D10. Idioma

Este cambio está escrito en español. Quedan en inglés los identificadores de código y las palabras que exige la herramienta: `Requirement`, `Scenario`, `WHEN`, `THEN`, `GIVEN`, `AND`, y la palabra normativa `MUST` o `SHALL`, que el validador de OpenSpec exige en cada requisito. Por eso cada requisito dice `DEBE (MUST)`: la prosa es española y la marca normativa es la mínima concesión al validador.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un error en la aritmética propia mueve dinero mal | Capas de D7; el oráculo detecta cualquier diferencia con la aritmética decimal exacta |
| `JSON.stringify` de un `Money` lanza una excepción por el `bigint` | `toJSON()` (D5) y un test |
| Un monto de 10¹² o más pasaba a la base y daba 500 | Tope en el constructor (D6), con 400 |
| Cambia el formato de algún texto que ve el cliente | `toString()` conserva el formato; hay tests de formato por moneda |
| La tasa llega con muchos decimales | Límite de 36 dígitos (D4) |
| Alguien reintroduce `decimal.js` | Regla de ESLint (D9) |

## Seguimientos

`exchange-on-money` e `investment-on-money` sobre la representación nueva; una columna `BIGINT` en la base solo si algún día hace falta que la base decida la escala; el formato con que `GET /wallet` devuelve saldos diminutos (hoy el `Decimal` de Prisma se serializa como `1e-8`); `toMinorUnits()` si alguna vez se expone un entero al estilo Stripe.
