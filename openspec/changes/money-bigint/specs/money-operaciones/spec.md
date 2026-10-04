## ADDED Requirements

### Requirement: Suma, resta y comparación son exactas y no mezclan monedas

`add`, `subtract`, `isLessThan` e `isGreaterThanOrEqual` DEBEN (MUST) operar con aritmética entera exacta, y DEBEN lanzar `CurrencyMismatchError` si las monedas difieren. `equals` DEBE ser falso entre monedas distintas, aunque el número coincida.

#### Scenario: Suma y resta
- **WHEN** se suma y se resta dentro de la misma moneda
- **THEN** los resultados DEBEN ser exactos, sin ningún error de redondeo

#### Scenario: Monedas distintas
- **WHEN** se suma, resta o compara un monto en ARS con uno en USD
- **THEN** DEBE lanzarse `CurrencyMismatchError`
- **AND** el mensaje DEBE nombrar las dos monedas

#### Scenario: Igualdad
- **WHEN** se comparan `Money.of("10", "ARS")` y `Money.of("10", "USD")` con `equals`
- **THEN** el resultado DEBE ser falso

#### Scenario: La comparación es exacta con precisión heredada
- **GIVEN** el saldo restaurado `1.0005` en `USD`
- **WHEN** se lo compara con `1.00` y con `1.01`
- **THEN** DEBE ser mayor o igual que `1.00`
- **AND** DEBE ser menor que `1.01`
- **AND** NO DEBE ser menor que `1.00`

#### Scenario: Cero y signo
- **WHEN** se consulta `isZero()` y `isNegative()` sobre cero, un positivo y un negativo
- **THEN** cada respuesta DEBE ser la correcta, y `-0` DEBE tratarse como cero

### Requirement: La conversión de moneda trunca hacia cero

`convertTo(moneda, tasa)` DEBE (MUST) multiplicar por la tasa en aritmética entera y truncar hacia cero a los decimales de la moneda destino. NUNCA DEBE redondear hacia arriba. El resultado DEBE ser idéntico al que producía la implementación anterior.

#### Scenario: Una conversión exacta
- **WHEN** se convierten `100 ARS` con tasa `0.001` a USD
- **THEN** el resultado DEBE ser `0.10 USD`

#### Scenario: El truncado no crea dinero
- **WHEN** se convierten `1000.50 ARS` con tasa `0.001` a USD
- **THEN** el resultado DEBE ser `1.00 USD`
- **AND** NO DEBE ser `1.01 USD`

#### Scenario: Un valor negativo trunca hacia cero
- **WHEN** se convierte un monto negativo cuyo resultado exacto tiene más decimales que la moneda destino
- **THEN** el resultado DEBE ser el valor truncado hacia cero, no el piso

#### Scenario: Tasas inválidas
- **WHEN** la tasa es `"0"`, `"-1"`, `"abc"`, `""` o tiene más de 36 dígitos
- **THEN** DEBE lanzarse `InvalidAmountError`

#### Scenario: Convertir a la misma moneda
- **WHEN** se convierte un `Money` a su propia moneda
- **THEN** DEBE lanzarse `CurrencyMismatchError`

#### Scenario: Equivalencia con la implementación anterior
- **GIVEN** una secuencia pseudoaleatoria de semilla fija de montos, monedas y tasas
- **WHEN** se compara cada resultado con el de `Prisma.Decimal` (multiplicar y truncar con `ROUND_DOWN`)
- **THEN** los textos DEBEN coincidir exactamente en todos los casos

### Requirement: Las operaciones respetan el tope de monto

Toda operación aritmética y de conversión DEBE (MUST) verificar el tope de monto sobre su resultado.

#### Scenario: Una conversión que supera el tope
- **WHEN** el resultado de una conversión es igual o mayor que 10¹²
- **THEN** DEBE lanzarse `AmountTooLargeError`

### Requirement: La aritmética se verifica contra un oráculo

La suite DEBE (MUST) comparar suma, resta, comparación y conversión contra `Prisma.Decimal` con una secuencia pseudoaleatoria determinista, de modo que cualquier diferencia sea reproducible.

#### Scenario: Reproducibilidad
- **WHEN** la suite se ejecuta dos veces con la misma semilla
- **THEN** DEBE producir los mismos casos
- **AND** un fallo DEBE imprimir la semilla y la entrada que lo causó

#### Scenario: Cobertura mínima
- **WHEN** corre la suite diferencial
- **THEN** DEBE ejercitar al menos 2000 casos por operación y por moneda
