cmake_minimum_required(VERSION 3.14)
project(tileid_encoder)

# pybind11을 서브폴더로 추가
add_subdirectory(pybind11)
pybind11_add_module(tileid_encoder encoder_pybind.cpp)
