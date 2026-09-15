---
title: "Go addition is tricky when you come from Ruby"
summary: "In Ruby the number grows as large as it must be. In Go it wraps at 8 bits and says nothing, unless the value is a constant, and then the compiler counts to 256 bits and refuses to round."
date: 2026-09-15
tags: [go, ruby]
cover_image: /images/posts/go-addition-is-tricky-when-you-come-from-ruby/cover.webp
status: published
---

Go addition is a bit tricky, especially when you come from Ruby. In Ruby, `+` is
a method, the number becomes as large as it must be, and you do not think about
it. In Go, `+` is an operator on a constant number of bits. Here is some
interesting mechanics of it.

## The number does not become larger

An integer type in Go has a constant width. An `int8` value has 8 bits, thus 256
possible bit patterns and no more. When the result does not fit, the processor
removes the carry bit:

```
  127   0111 1111      the maximum int8 value
+   1   0000 0001
-------------------
 -128   1000 0000      the minimum int8 value
```

This is correct binary addition. Only the interpretation changed: in two's
complement the highest bit has the weight -128.

So addition of integers in Go is arithmetic modulo 2^n. The result is always a
valid value of the type. Thus Go has no condition to report. There is no panic,
and there is no error message. A panic occurs only for a division by zero.

![126, then 127, then -128, and no error message](/images/posts/go-addition-is-tricky-when-you-come-from-ruby/silent-overflow.webp)

The good part is that the Go specification defines this behavior. The result is
the same on all platforms and in all builds. In C, signed overflow is undefined,
and the compiler can do what it wants with it.

## Two integers are not always addable

The two operands must have the same type. Go does not convert numeric types
automatically:

```go
var a int32 = 1
var b int64 = 2
a + b              // error: mismatched types int32 and int64
int64(a) + b       // correct
```

Also, `+` is only the operator that Go gives you. Go has no operator
overloading, thus you cannot write `+` for your own type. There is no equivalent
of a Ruby `def +(other)`.

## The compiler calculates better than the program

This part surprised me most. A constant in Go is not a small value in a type.
The compiler holds it exactly, with arbitrary precision. The specification
requires a minimum of 256 bits. A constant also has no location in memory. Thus
a constant cannot overflow.

The type comes later, at the point of use: an assignment, an argument, a return
value, or an operation with a typed operand. All the interesting behavior occurs
at that point, because there the exact value must go into a type.

If the value does not fit, you get a compile error, and not a wrapped value:

```go
const big = 1<<100 + 1<<100          // correct, and the value is exact
var c int8 = 255 + 255 + 255 + 255   // error: constant 1020 overflows int8
```

The same arithmetic on variables gives no error message, and it gives a
different answer. Each step wraps:

```go
x := 255
v := int8(x)                // the value becomes -1
fmt.Println(v + v + v + v)  // the result is -4
```

Floating-point values show the same rule, with rounding in place of wrapping.
The compiler adds the two constants exactly, and it rounds one time at the point
of use. The processor must round each operand first, and then add:

```go
a, b := 0.1, 0.2
fmt.Println(a + b)          // 0.30000000000000004
fmt.Println(0.1+0.2 == 0.3) // true
```

The point of use is not always visible. If no context gives a type, the constant
gets its default type, and for an integer this is `int`:

```go
fmt.Println(math.MaxUint64)          // does not compile
fmt.Println(uint64(math.MaxUint64))  // correct
```

The parameter type is `any`, and an interface gives no type to the constant.
Thus the constant becomes an `int`, and the value does not fit in it.

![Confused math lady: fmt.Println(math.MaxUint64) does not compile](/images/posts/go-addition-is-tricky-when-you-come-from-ruby/constant-default-type.webp)

## `++` gives no value

`x++` is a statement and not an expression. There is no prefix form, and you
cannot use it in an assignment or in a call:

```go
x++            // correct
y := x++       // error
f(x++)         // error
++x            // error
```

This is intentional. It prevents the errors of evaluation sequence that occur in
C. Ruby has no `++` at all, for a related reason.

`x += y` has one more difference from `x = x + y`: Go evaluates the left operand
one time only. This is important when the index has a side effect.

```go
a[f()] += 1          // the program calls f one time
a[f()] = a[f()] + 1  // the program calls f two times
```

## When you want the Ruby behavior again

The `math/big` package gives you what Ruby does by default. A `big.Int` value
cannot overflow, and a `big.Rat` value holds an exact fraction.

The method pattern is not usual: the receiver is the destination, and the method
changes it and then returns it.

```go
z := new(big.Int)
z.Add(x, y)        // z becomes x + y
```

The return value is only for chains. The important effect is that you can use
the same destination again. Thus a loop allocates memory one time, and not at
each step:

```go
sum := new(big.Int)
for _, v := range values {
    sum.Add(sum, v)
}
```

The zero value is ready for use and is equal to 0. But be careful: the types are
not safe for concurrent writes, you must not copy a used `big.Int` with `=` (use
`Set`), and the package is much slower than `+`.

## The test that you must write

The standard library has no checked addition for signed integers. You must write
it:

```go
func AddChecked(x, y int) (int, error) {
    if (y > 0 && x > math.MaxInt-y) || (y < 0 && x < math.MinInt-y) {
        return 0, errors.New("integer overflow")
    }
    return x + y, nil
}
```

For unsigned values, `bits.Add64` from `math/bits` returns the carry as a second
value. It compiles to one instruction, thus it has no cost in performance:

```go
sum, carry := bits.Add64(x, y, 0)   // a carry of 1 shows an overflow
```

Add a test like this when the input comes from a user or from a network. In
other places `+` is sufficient. And do not use `float64` for money: use an
integer of minor units, or `big.Rat`.

---

I hope that this helps someone. Go gives you exact arithmetic at compile time
and silent wrapping at run time, and it is useful to know which one you have.
