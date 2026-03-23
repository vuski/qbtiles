#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include "encoder.cpp"

namespace py = pybind11;

py::array_t<uint64_t> encode_array(py::array_t<uint64_t> input) {
    auto buf = input.request();
    auto ptr = static_cast<uint64_t*>(buf.ptr);
    size_t n = buf.size;

    py::array_t<uint64_t> result(n);
    auto out = static_cast<uint64_t*>(result.request().ptr);

    for (size_t i = 0; i < n; i++) {
        out[i] = tileid_to_quadkey_int64(ptr[i]);
    }

    return result;
}

PYBIND11_MODULE(tileid_encoder, m) {
    m.def("encode_array", &encode_array, "Tile ID to quadkey int64");
}
