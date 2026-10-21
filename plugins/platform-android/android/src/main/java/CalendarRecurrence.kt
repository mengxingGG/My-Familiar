package app.familiar.platform

import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** 由明确的重复计划生成标准规则，日期与时区验证仍在原生所有者中执行。 */
object CalendarRecurrence {
    private val week = listOf("MO", "TU", "WE", "TH", "FR", "SA", "SU")
    private fun integer(value: JSONObject, key: String, min: Int, max: Int): Int {
        val raw = value.get(key)
        require(raw is Number && raw.toDouble() == raw.toInt().toDouble() && raw.toInt() in min..max) { "INVALID_INPUT" }
        return raw.toInt()
    }
    fun rule(value: JSONObject, start: OffsetDateTime, zone: ZoneId, allDay: Boolean): String {
        require(value.keys().asSequence().all { it in setOf("frequency", "interval", "weekDays", "count", "until") }) { "INVALID_INPUT" }
        val frequency = value.getString("frequency")
        require(frequency in listOf("daily", "weekly", "monthly", "yearly") && !(value.has("count") && value.has("until"))) { "INVALID_INPUT" }
        val parts = mutableListOf("FREQ=${frequency.uppercase(java.util.Locale.ROOT)}", "INTERVAL=${if(value.has("interval")) integer(value,"interval",1,100) else 1}")
        if (frequency == "weekly") {
            val days = if (value.has("weekDays")) {
                val raw = value.getJSONArray("weekDays")
                require(raw.length() in 1..7) { "INVALID_INPUT" }
                (0 until raw.length()).map { require(raw.get(it) is String) { "INVALID_INPUT" };raw.getString(it) }
            } else listOf(week[start.dayOfWeek.value - 1])
            require(days.distinct().size == days.size && days.all { it in week } && week[start.dayOfWeek.value - 1] in days) { "INVALID_INPUT" }
            parts.add("BYDAY=" + week.filter { it in days }.joinToString(","));parts.add("WKST=MO")
        } else require(!value.has("weekDays")) { "INVALID_INPUT" }
        if (value.has("count")) parts.add("COUNT=${integer(value,"count",1,10000)}")
        if (value.has("until")) {
            val text = value.getString("until")
            require(text.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))) { "INVALID_INPUT" }
            val date = LocalDate.parse(text)
            require(date >= start.toLocalDate()) { "INVALID_INPUT" }
            val until = if (allDay) date.format(DateTimeFormatter.BASIC_ISO_DATE)
                else date.plusDays(1).atStartOfDay(zone).minusSeconds(1).withZoneSameInstant(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'"))
            parts.add("UNTIL=$until")
        }
        return parts.joinToString(";")
    }
}
