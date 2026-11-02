class InvoiceCalculator:
    """Computes invoice totals."""

    def total(self, items):
        return sum(item.amount for item in items)


def apply_discount(total, percent):
    return total * (1 - percent / 100)
