## ADDED Requirements

### Requirement: Un Money guarda un entero de punto fijo y nunca pasa por un número de coma flotante

`Money` DEBE (MUST) guardar su valor como un `bigint` con resolución de 10⁻⁸ (`LEDGER_SCALE = 8`) junto con su moneda, y NO DEBE usar `number`, `parseFloat` ni ninguna librería decimal para representarlo ni para operarlo.

#### Scenario: Un valor decimal se mantiene exacto
- **WHEN** se construye `Money.of("0.1", "ARS")` y se le suma `Money.of("0.2", "ARS")`
- **THEN** el resultado DEBE mostrarse como `0.30`
- **AND** su `toLedgerString()` DEBE ser `0.30000000`

#### Scenario: El constructor es privado
- **WHEN** código externo intenta crear un `Money` sin pasar por `of`, `zero` o `restore`
- **THEN** DEBE fallar al compilar

#### Scenario: Un Money es inmutable
- **WHEN** se opera con un `Money` (suma, resta, conversión)
- **THEN** los operandos DEBEN quedar sin cambios
- **AND** la operación DEBE devolver un `Money` nuevo

### Requirement: `of` valida la entrada de un cliente

`Money.of(texto, moneda)` DEBE (MUST) aceptar solo notación decimal plana (`-?\d+(\.\d+)?`) y DEBE rechazar más decimales de los que admite la moneda: ARS, USD y BRL admiten 2 y USDT admite 6.

#### Scenario: Entrada válida
- **WHEN** se construye `Money.of("10.12", "ARS")` y `Money.of("10.123456", "USDT")`
- **THEN** ambos DEBEN construirse sin error

#### Scenario: Demasiados decimales
- **WHEN** se construye `Money.of("10.123", "ARS")` o `Money.of("10.1234567", "USDT")`
- **THEN** DEBE lanzarse `PrecisionError`
- **AND** el error DEBE exponer la moneda y la cantidad máxima de decimales

#### Scenario: Texto que no es un decimal plano
- **WHEN** se construye con `""`, `" "`, `"abc"`, `"1,5"`, `"NaN"`, `"Infinity"` o `"1e400"`
- **THEN** cada caso DEBE lanzar `InvalidAmountError`

#### Scenario: Negativos
- **WHEN** se construye `Money.of("-50", "ARS")`
- **THEN** DEBE aceptarse
- **AND** `isNegative()` DEBE ser verdadero

### Requirement: `restore` carga valores ya guardados con hasta 8 decimales

`Money.restore(texto, moneda)` DEBE (MUST) aceptar hasta 8 decimales aunque la moneda admita menos, y DEBE rechazar más de 8.

#### Scenario: Un saldo heredado
- **WHEN** se restaura `"1.0005"` en `USD`
- **THEN** DEBE construirse
- **AND** `isLessThan(Money.of("1.01", "USD"))` DEBE ser verdadero
- **AND** `isGreaterThanOrEqual(Money.of("1.00", "USD"))` DEBE ser verdadero

#### Scenario: El menor valor que guarda la base
- **WHEN** se restaura `"0.00000001"`
- **THEN** DEBE construirse y no ser cero

#### Scenario: Más precisión de la que existe en la base
- **WHEN** se restaura `"0.000000001"` (9 decimales)
- **THEN** DEBE lanzarse `InvalidAmountError`

#### Scenario: Texto inválido
- **WHEN** se restaura `""`, `"abc"`, `"1e-8"` o `"NaN"`
- **THEN** cada caso DEBE lanzar `InvalidAmountError`

### Requirement: Ningún valor puede ser igual o mayor que 10¹²

Todo `Money`, ya sea por entrada o por el resultado de una operación, DEBE (MUST) cumplir `|valor| < 10¹²`, el límite de `NUMERIC(20,8)`. Esa verificación DEBE hacerse en un único lugar por el que pasen todas las rutas de construcción.

#### Scenario: El mayor valor permitido
- **WHEN** se construye `Money.of("999999999999.99", "ARS")`
- **THEN** DEBE aceptarse

#### Scenario: El primer valor rechazado
- **WHEN** se construye `Money.of("1000000000000", "ARS")`
- **THEN** DEBE lanzarse `AmountTooLargeError`

#### Scenario: Una suma que se pasa del tope
- **GIVEN** dos montos de `600000000000` en ARS
- **WHEN** se los suma
- **THEN** DEBE lanzarse `AmountTooLargeError`

#### Scenario: El tope también vale en negativo
- **WHEN** se construye `Money.of("-1000000000000", "ARS")`
- **THEN** DEBE lanzarse `AmountTooLargeError`

### Requirement: Mostrar y escribir son dos operaciones distintas

`toString()` DEBE (MUST) mostrar el valor con los decimales de su moneda; `toLedgerString()` DEBE devolver el valor exacto con 8 decimales, sin redondeo y sin notación exponencial; `toJSON()` DEBE devolver `toString()` para que serializar un `Money` no lance una excepción.

#### Scenario: Formato por moneda
- **WHEN** se muestra `Money.of("100.5", "ARS")` y `Money.of("1", "USDT")`
- **THEN** DEBEN mostrarse `100.50` y `1.000000`

#### Scenario: `toLedgerString` no pierde precisión
- **WHEN** se llama `toLedgerString()` sobre el valor restaurado `1.0005` en `USD`
- **THEN** DEBE devolver `1.00050000`

#### Scenario: `toString` redondea half-up solo para mostrar
- **WHEN** se muestra el valor restaurado `1.0005` en `USD`
- **THEN** DEBE mostrarse `1.00`
- **AND** `toLedgerString()` DEBE seguir devolviendo `1.00050000`

#### Scenario: Valores diminutos sin notación exponencial
- **WHEN** se llama `toLedgerString()` sobre el valor restaurado `0.00000005`
- **THEN** DEBE devolver `0.00000005`

#### Scenario: Serializar a JSON
- **WHEN** se ejecuta `JSON.stringify({ monto: Money.of("500", "ARS") })`
- **THEN** NO DEBE lanzar una excepción
- **AND** DEBE producir `{"monto":"500.00"}`
