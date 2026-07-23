/* Validação, formatação e limpeza de CNPJ. Carregado como script global
   (sem módulos ES) para poder ser reaproveitado por background, popup,
   options e content scripts sem duplicar código. */
(function (root) {
  function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function isValid(cnpj) {
    const digits = onlyDigits(cnpj);
    if (digits.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(digits)) return false;

    const calcCheckDigit = (base) => {
      let weight = base.length - 7;
      let sum = 0;
      for (let i = 0; i < base.length; i++) {
        sum += Number(base[i]) * weight;
        weight--;
        if (weight < 2) weight = 9;
      }
      const rest = sum % 11;
      return rest < 2 ? 0 : 11 - rest;
    };

    const base12 = digits.slice(0, 12);
    const dv1 = calcCheckDigit(base12);
    const dv2 = calcCheckDigit(base12 + String(dv1));
    return digits === base12 + String(dv1) + String(dv2);
  }

  function format(cnpj) {
    const d = onlyDigits(cnpj);
    if (d.length !== 14) return cnpj;
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }

  root.CNPJUtil = { onlyDigits, isValid, format };
})(typeof window !== 'undefined' ? window : globalThis);
