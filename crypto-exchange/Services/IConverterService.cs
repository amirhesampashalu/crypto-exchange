using System.Globalization;

namespace crypto_exchange.Services
{
    public interface IConverterService
    {
        string ToPersian(DateTime date);
    }

    public class ConverterService : IConverterService
    {
        public string ToPersian(DateTime date)
        {
            var pc = new PersianCalendar();
            return $"{pc.GetYear(date):0000}/{pc.GetMonth(date):00}/{pc.GetDayOfMonth(date):00}";
        }
    } 
 }
