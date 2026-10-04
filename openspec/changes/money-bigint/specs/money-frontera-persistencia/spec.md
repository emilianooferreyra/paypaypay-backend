## ADDED Requirements

### Requirement: Los saldos se leen sin notación exponencial

Los adaptadores de Prisma DEBEN (MUST) leer los montos con `toFixed(8)` y NUNCA con `toString()`, porque el `Decimal` de Prisma imprime los valores menores a 10⁻⁶ en notación exponencial.

#### Scenario: Una wallet con un saldo diminuto se puede cargar
- **GIVEN** una wallet en USD con saldo `0.00000005`
- **WHEN** se deposita en ella
- **THEN** la operación DEBE completarse
- **AND** el saldo DEBE ser `0.00000005` más el monto depositado

#### Scenario: Todos los tamaños de polvo
- **GIVEN** wallets con saldos `0.0000001`, `0.00000001` y `0.00000005`
- **WHEN** se las carga
- **THEN** ninguna DEBE fallar

#### Scenario: Un saldo heredado sigue funcionando
- **GIVEN** una wallet con saldo `1.0005` en USD
- **WHEN** se retira `1.00`
- **THEN** DEBE completarse
- **AND** el saldo DEBE quedar en `0.0005`

### Requirement: Se escribe siempre con `toLedgerString`

Los adaptadores DEBEN (MUST) construir cada `Decimal` de escritura con `toLedgerString()`, y NUNCA con `toString()`.

#### Scenario: El valor escrito es exacto
- **WHEN** se acredita un monto de `500.00` en ARS
- **THEN** el `Decimal` enviado a la base DEBE construirse con `500.00000000`

#### Scenario: Ida y vuelta sin pérdida
- **GIVEN** un `Money` cualquiera con a lo sumo 8 decimales
- **WHEN** se escribe en la base con `toLedgerString()` y se lee con `toFixed(8)`
- **THEN** el `Money` leído DEBE ser igual al original

### Requirement: Un monto demasiado grande se informa como error del cliente

`toMoney` DEBE (MUST) traducir `AmountTooLargeError` a una respuesta 400 con un mensaje que indique el máximo.

#### Scenario: Un depósito de 10¹²
- **WHEN** un cliente deposita `1000000000000`
- **THEN** la respuesta DEBE ser 400
- **AND** NO DEBE ser un 500 de la base de datos

#### Scenario: Un depósito que dejaría el saldo por encima del tope
- **GIVEN** una wallet en ARS con saldo `999999999999.99`
- **WHEN** se deposita `0.02`
- **THEN** la respuesta DEBE ser 422 con un mensaje que diga que el saldo resultante superaría el máximo
- **AND** el saldo DEBE quedar sin cambios
- **AND** NO DEBE ser un 500 de la base de datos

#### Scenario: Las respuestas existentes no cambian
- **WHEN** un cliente envía demasiados decimales o un texto que no es un número
- **THEN** DEBE recibir los mismos 400 y mensajes que antes de este cambio

### Requirement: Nuestro código no depende de una librería decimal

El código propio NO DEBE (MUST NOT) importar `decimal.js`, y `decimal.js` NO DEBE figurar en `dependencies`.

#### Scenario: Un import prohibido
- **GIVEN** un archivo propio que importa de `decimal.js`
- **WHEN** corre ESLint
- **THEN** DEBE informar un error que remita al ADR 0002

#### Scenario: Sin dependencia directa
- **WHEN** se lee `package.json`
- **THEN** `dependencies` NO DEBE contener `decimal.js`

#### Scenario: Prisma sigue funcionando
- **WHEN** corren las pruebas de integración
- **THEN** las columnas `Decimal` DEBEN leerse y escribirse con normalidad
